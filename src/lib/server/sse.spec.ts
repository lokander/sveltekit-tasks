import { describe, it, expect } from "vitest";
import { TaskManager } from "./manager.js";
import type { RequestEvent } from "@sveltejs/kit";
import type { TaskSSEMessage } from "../shared/types.js";

function makeEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    locals: {},
    request: new Request("http://localhost/sse/tasks"),
    url: new URL("http://localhost/sse/tasks"),
    ...overrides,
  } as unknown as RequestEvent;
}

function makeEventWithParam(params: Record<string, string>): RequestEvent {
  const url = new URL("http://localhost/sse/tasks");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return {
    locals: {},
    request: new Request(url),
    url,
  } as unknown as RequestEvent;
}

function makeEventWithHeader(headers: Record<string, string>): RequestEvent {
  const url = new URL("http://localhost/sse/tasks");
  return {
    locals: {},
    request: new Request(url, { headers }),
    url,
  } as unknown as RequestEvent;
}

async function readMessages(response: Response, count: number): Promise<TaskSSEMessage[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: TaskSSEMessage[] = [];
  let buffer = "";

  while (messages.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      // Parse SSE blocks: extract the data line from "data: ..."
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        messages.push(JSON.parse(dataLine.slice(6)));
      }
    }
  }

  reader.releaseLock();
  return messages;
}

async function readRawChunks(response: Response, count: number): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  for (let i = 0; i < count; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return result;
}

describe("createSSEHandler", () => {
  it("returns a 403 when authorize rejects", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler({
      authorize: () => false,
    });

    const response = await handler(makeEvent());
    expect(response.status).toBe(403);
  });

  it("returns SSE headers", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler();

    const response = await handler(makeEvent());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sends init messages for all registered tasks", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});
    tm.register("b", async () => {});

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    const messages = await readMessages(response, 2);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      type: "init",
      task: { id: "a", status: "pending" },
    });
    expect(messages[1]).toEqual({
      type: "init",
      task: { id: "b", status: "pending" },
    });
  });

  it("streams update messages when tasks change", async () => {
    const tm = new TaskManager();
    tm.register("test", async (ctx) => {
      ctx.progress("Working...", 1, 2);
    });

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    // Read the init message first
    const initMessages = await readMessages(response, 1);
    expect(initMessages[0].type).toBe("init");

    // Start the task — should produce update messages
    tm.start("test");

    // Wait for handler to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Read update messages (running + progress + completed)
    const updates = await readMessages(response, 1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].type).toBe("update");
  });

  it("sends data-only SSE messages without event field", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    const raw = await readRawChunks(response, 1);
    expect(raw).toContain("data: ");
    expect(raw).not.toContain("event:");
  });

  it("includes id field in SSE messages", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    const raw = await readRawChunks(response, 1);
    expect(raw).toMatch(/id: \d+/);
  });

  it("supports async authorize", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler({
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      },
    });

    const response = await handler(makeEvent());
    expect(response.status).toBe(200);
  });

  it("replays buffered events when client provides lastEventId", async () => {
    const tm = new TaskManager({ eventBufferSize: 100 });
    tm.register("test", async (ctx) => {
      ctx.progress("Step 1", 1, 2);
      ctx.progress("Step 2", 2, 2);
    });

    const handler = tm.createSSEHandler();

    // First connection — get init
    const response1 = await handler(makeEvent());
    const inits = await readMessages(response1, 1);
    expect(inits[0].type).toBe("init");

    // Start task to generate buffered events
    tm.start("test");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconnect with lastEventId=0 — should replay all buffered events
    const response2 = await handler(makeEventWithParam({ lastEventId: "0" }));
    const replayed = await readMessages(response2, 1);
    expect(replayed[0].type).toBe("update");
  });

  it("falls back to init dump when buffer cannot satisfy lastEventId", async () => {
    const tm = new TaskManager({ eventBufferSize: 1 });
    tm.register("test", async (ctx) => {
      ctx.progress("p1");
      ctx.progress("p2");
      ctx.progress("p3");
    });

    const handler = tm.createSSEHandler();

    // Generate events that overflow the tiny buffer
    tm.start("test");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconnect with very old lastEventId — buffer can't serve
    const response = await handler(makeEventWithParam({ lastEventId: "0" }));
    const messages = await readMessages(response, 1);
    expect(messages[0].type).toBe("init");
  });

  it("reads Last-Event-ID from request header (SSE spec)", async () => {
    const tm = new TaskManager({ eventBufferSize: 100 });
    tm.register("test", async (ctx) => {
      ctx.progress("Step 1", 1, 2);
    });

    const handler = tm.createSSEHandler();

    // Generate buffered events
    tm.start("test");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconnect with Last-Event-ID header
    const response = await handler(makeEventWithHeader({ "Last-Event-ID": "0" }));
    const replayed = await readMessages(response, 1);
    expect(replayed[0].type).toBe("update");
  });

  it("does not include Connection header in response", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler();

    const response = await handler(makeEvent());
    expect(response.headers.get("Connection")).toBeNull();
  });
});
