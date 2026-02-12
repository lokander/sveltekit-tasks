import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import UseTaskEventsTest from "./UseTaskEventsTest.svelte";

type EventSourceListener = (event: MessageEvent | Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: EventSourceListener | null = null;
  onerror: EventSourceListener | null = null;
  onopen: EventSourceListener | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async open
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));
    });
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  // Test helper: simulate an incoming SSE message with optional lastEventId
  simulateMessage(data: string, lastEventId?: string) {
    this.onmessage?.(new MessageEvent("message", { data, lastEventId: lastEventId ?? "" }));
  }

  // Test helper: simulate an error
  simulateError() {
    this.onerror?.(new Event("error"));
  }
}

let OriginalEventSource: typeof EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  globalThis.EventSource = OriginalEventSource;
});

function latestMock(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

describe("TaskEventSource", () => {
  it("connects and sets connected to true", async () => {
    const screen = render(UseTaskEventsTest, { url: "/test/sse" });
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");
  });

  it("populates tasks from init messages", async () => {
    const screen = render(UseTaskEventsTest, { url: "/test/sse" });
    // Wait for connection
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock = latestMock();
    mock.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "task-a", status: "pending" } }),
    );
    mock.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "task-b", status: "running" } }),
    );

    await expect.element(screen.getByTestId("task-count")).toHaveTextContent("2");
    await expect.element(screen.getByTestId("task-task-a")).toHaveTextContent("task-a:pending");
    await expect.element(screen.getByTestId("task-task-b")).toHaveTextContent("task-b:running");
  });

  it("updates tasks from update messages", async () => {
    const screen = render(UseTaskEventsTest, { url: "/test/sse" });
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock = latestMock();
    mock.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "task-a", status: "pending" } }),
    );
    mock.simulateMessage(
      JSON.stringify({
        type: "update",
        taskId: "task-a",
        state: { id: "task-a", status: "running", progress: { message: "Working..." } },
      }),
    );

    await expect.element(screen.getByTestId("task-task-a")).toHaveTextContent("task-a:running");
  });

  it("ignores invalid JSON messages", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const screen = render(UseTaskEventsTest, { url: "/test/sse" });
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock = latestMock();
    mock.simulateMessage("not json{{{");
    mock.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "task-a", status: "pending" } }),
    );

    await expect.element(screen.getByTestId("task-count")).toHaveTextContent("1");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("sets connected to false on error", async () => {
    const onError = vi.fn();
    const screen = render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { onError, maxRetries: 0 },
    });
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock = latestMock();
    mock.simulateError();

    await expect.element(screen.getByTestId("connected")).toHaveTextContent("false");
    expect(onError).toHaveBeenCalled();
  });

  it("includes lastEventId in reconnect URL", async () => {
    vi.useFakeTimers();
    render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { reconnectDelay: 100, maxRetries: 3 },
    });

    // Wait for the initial connection (microtask)
    await vi.advanceTimersByTimeAsync(0);

    const mock1 = latestMock();
    // Send a message with lastEventId
    mock1.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "task-a", status: "pending" } }),
      "42",
    );

    // Simulate disconnect
    mock1.simulateError();

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(200);

    // A new EventSource should have been created with lastEventId in the URL
    const mock2 = latestMock();
    expect(mock2).not.toBe(mock1);
    expect(mock2.url).toContain("lastEventId=42");

    vi.useRealTimers();
  });
});
