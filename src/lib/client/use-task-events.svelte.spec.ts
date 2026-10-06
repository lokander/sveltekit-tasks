import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import UseTaskEventsTest from "./UseTaskEventsTest.svelte";

type EventSourceListener = (event: MessageEvent | Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  /** When `false`, connections stay in CONNECTING until `simulateOpen()` — models a server that is down. */
  static autoOpen = true;
  url: string;
  onmessage: EventSourceListener | null = null;
  onerror: EventSourceListener | null = null;
  onopen: EventSourceListener | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async open
    if (MockEventSource.autoOpen) queueMicrotask(() => this.simulateOpen());
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  // Test helper: simulate the connection opening
  simulateOpen() {
    if (this.readyState === 2) return;
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
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
  MockEventSource.autoOpen = true;
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

  it('reports "connecting" on first load, distinct from "reconnecting" after a drop', async () => {
    vi.useFakeTimers();
    MockEventSource.autoOpen = false;
    const screen = render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { reconnectDelay: 100 },
    });

    // Fresh page load, before the first onopen: connecting, not an error state
    await expect.element(screen.getByTestId("status")).toHaveTextContent("connecting");
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("false");

    latestMock().simulateOpen();
    await expect.element(screen.getByTestId("status")).toHaveTextContent("open");

    // Connection drops: reconnecting while the backoff timer runs and during the retry
    latestMock().simulateError();
    await expect.element(screen.getByTestId("status")).toHaveTextContent("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    expect(MockEventSource.instances).toHaveLength(2);
    await expect.element(screen.getByTestId("status")).toHaveTextContent("reconnecting");

    latestMock().simulateOpen();
    await expect.element(screen.getByTestId("status")).toHaveTextContent("open");

    vi.useRealTimers();
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

  it("removes tasks from removed messages", async () => {
    const screen = render(UseTaskEventsTest, { url: "/test/sse" });
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock = latestMock();
    mock.simulateMessage(JSON.stringify({ type: "init", task: { id: "a", status: "pending" } }));
    mock.simulateMessage(JSON.stringify({ type: "init", task: { id: "b", status: "pending" } }));
    await expect.element(screen.getByTestId("task-count")).toHaveTextContent("2");

    mock.simulateMessage(JSON.stringify({ type: "removed", taskId: "a" }));

    await expect.element(screen.getByTestId("task-count")).toHaveTextContent("1");
    await expect.element(screen.getByTestId("task-a")).not.toBeInTheDocument();
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
    // maxRetries: 0 — the very first failure exhausts the budget
    await expect.element(screen.getByTestId("status")).toHaveTextContent("exhausted");
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

  it("URL-encodes the lastEventId", async () => {
    vi.useFakeTimers();
    render(UseTaskEventsTest, { url: "/test/sse", options: { reconnectDelay: 100 } });
    await vi.advanceTimersByTimeAsync(0);

    const mock1 = latestMock();
    mock1.simulateMessage(
      JSON.stringify({ type: "init", task: { id: "a", status: "pending" } }),
      "ab12:7",
    );
    mock1.simulateError();
    await vi.advanceTimersByTimeAsync(200);

    expect(latestMock().url).toBe("/test/sse?lastEventId=ab12%3A7");
    vi.useRealTimers();
  });

  it("stops reconnecting after maxRetries and reports exhausted", async () => {
    vi.useFakeTimers();
    const screen = render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { reconnectDelay: 100, maxReconnectDelay: 100, maxRetries: 2 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    // Server goes down: every new connection fails without opening
    MockEventSource.autoOpen = false;

    // Drop the live connection, then fail 2 retries = 3 EventSource instances in total
    for (let i = 0; i < 3; i++) {
      latestMock().simulateError();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(MockEventSource.instances).toHaveLength(3);

    // Further time passes — no new connections
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockEventSource.instances).toHaveLength(3);
    await expect.element(screen.getByTestId("exhausted")).toHaveTextContent("true");
    await expect.element(screen.getByTestId("status")).toHaveTextContent("exhausted");
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("false");

    // Server is back; reconnect() resets the retry budget and connects immediately
    MockEventSource.autoOpen = true;
    screen.component.getSource().reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockEventSource.instances).toHaveLength(4);
    await expect.element(screen.getByTestId("exhausted")).toHaveTextContent("false");
    await expect.element(screen.getByTestId("status")).toHaveTextContent("open");
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    vi.useRealTimers();
  });

  it("close() closes the EventSource and stops reconnecting; reconnect() reopens", async () => {
    vi.useFakeTimers();
    const screen = render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { reconnectDelay: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    const mock1 = latestMock();
    mock1.simulateMessage(JSON.stringify({ type: "init", task: { id: "a", status: "pending" } }));

    screen.component.getSource().close();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mock1.readyState).toBe(2); // CLOSED
    expect(MockEventSource.instances).toHaveLength(1);
    await expect.element(screen.getByTestId("closed")).toHaveTextContent("true");
    await expect.element(screen.getByTestId("status")).toHaveTextContent("closed");
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("false");
    // Task map is retained
    await expect.element(screen.getByTestId("task-count")).toHaveTextContent("1");

    screen.component.getSource().reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockEventSource.instances).toHaveLength(2);
    await expect.element(screen.getByTestId("closed")).toHaveTextContent("false");
    await expect.element(screen.getByTestId("status")).toHaveTextContent("open");
    await expect.element(screen.getByTestId("connected")).toHaveTextContent("true");

    vi.useRealTimers();
  });

  it("closes the EventSource and cancels a pending reconnect on unmount", async () => {
    vi.useFakeTimers();
    const screen = render(UseTaskEventsTest, {
      url: "/test/sse",
      options: { reconnectDelay: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);

    const mock1 = latestMock();
    expect(mock1.readyState).toBe(1); // OPEN

    // Schedule a reconnect, then unmount before it fires
    mock1.simulateError();
    screen.unmount();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mock1.readyState).toBe(2); // CLOSED
    expect(MockEventSource.instances).toHaveLength(1);

    vi.useRealTimers();
  });
});
