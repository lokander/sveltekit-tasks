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

type Block = { id: string | undefined; msg: TaskSSEMessage };

/** Read `count` SSE blocks (ignoring comments) and return their id + parsed payload. */
async function readBlocks(response: Response, count: number): Promise<Block[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const blocks: Block[] = [];
  let buffer = "";

  while (blocks.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const raw = buffer.split("\n\n");
    buffer = raw.pop() ?? "";

    for (const block of raw) {
      const lines = block.split("\n");
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (dataLine) {
        const idLine = lines.find((line) => line.startsWith("id: "));
        blocks.push({ id: idLine?.slice(4), msg: JSON.parse(dataLine.slice(6)) });
      }
    }
  }

  reader.releaseLock();
  return blocks;
}

async function readMessages(response: Response, count: number): Promise<TaskSSEMessage[]> {
  return (await readBlocks(response, count)).map((b) => b.msg);
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

/** Race a read against a short timeout, so tests can assert that nothing arrives. */
async function readOrTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 50,
): Promise<string | "timeout" | "done"> {
  const result = await Promise.race([
    reader.read(),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
  if (result === "timeout") return "timeout";
  if (result.done) return "done";
  return new TextDecoder().decode(result.value);
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect, read the init dump and return the `<epoch>:<id>` of the last init message. */
async function connectAndGetLastEventId(tm: TaskManager, initCount: number): Promise<string> {
  const response = await tm.createSSEHandler()(makeEvent());
  const blocks = await readBlocks(response, initCount);
  return blocks[blocks.length - 1].id!;
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
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
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

  // Lets the client drop tasks it knew about that the dump no longer contains
  it("ends the init dump with a synced message", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});
    tm.register("b", async () => {});

    const response = await tm.createSSEHandler()(makeEvent());
    const blocks = await readBlocks(response, 3);

    expect(blocks.map((b) => b.msg.type)).toEqual(["init", "init", "synced"]);
    expect(blocks[2].id).toBe(blocks[1].id);
  });

  it("sends a synced message with an event id when there are no tasks", async () => {
    const tm = new TaskManager();

    const response = await tm.createSSEHandler()(makeEvent());
    const [block] = await readBlocks(response, 1);

    expect(block.msg).toEqual({ type: "synced" });
    expect(block.id).toMatch(/^[a-z0-9]+:\d+$/);
  });

  it("streams update messages when tasks change", async () => {
    const tm = new TaskManager();
    tm.register("test", async (ctx) => {
      ctx.progress("Working...", 1, 2);
    });

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    // Read the init message first
    const initMessages = await readMessages(response, 2); // init + synced
    expect(initMessages[0].type).toBe("init");

    // Start the task — should produce update messages
    tm.start("test");

    // Wait for handler to run
    await tick(50);

    // Read update messages (running + progress + completed)
    const updates = await readMessages(response, 1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].type).toBe("update");
  });

  it("streams an update when a task is registered after connecting", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});

    const response = await tm.createSSEHandler()(makeEvent());
    await readMessages(response, 2); // init + synced

    tm.register("b", async () => {});

    const [msg] = await readMessages(response, 1);
    expect(msg).toEqual({ type: "update", taskId: "b", state: { id: "b", status: "pending" } });
  });

  it("streams a removed message when an ephemeral task is evicted", async () => {
    const tm = new TaskManager({ maxHistory: 1 });
    tm.register("job-1", async () => {}, { ephemeral: true });
    tm.register("job-2", async () => {}, { ephemeral: true });

    const response = await tm.createSSEHandler()(makeEvent());
    await readMessages(response, 3); // 2 init + synced

    tm.start("job-1");
    await tick();
    tm.start("job-2");
    await tick();

    // job-1: running, completed; job-2: running, completed; then job-1 removed
    const messages = await readMessages(response, 5);
    expect(messages[4]).toEqual({ type: "removed", taskId: "job-1" });
  });

  // Node's `http` server only sends response headers with the first body chunk, and
  // EventSource doesn't fire `open` until it sees them.
  it("sends a comment immediately when there is nothing to dump", async () => {
    const tm = new TaskManager();

    const response = await tm.createSSEHandler()(makeEvent());
    const reader = response.body!.getReader();

    expect(await readOrTimeout(reader)).toMatch(/^: /);
  });

  it("sends a comment immediately when a replay has no missed events", async () => {
    const tm = new TaskManager({ eventBufferSize: 10 });
    tm.register("a", async () => {});
    const lastEventId = await connectAndGetLastEventId(tm, 1);

    const response = await tm.createSSEHandler()(makeEventWithParam({ lastEventId }));
    const reader = response.body!.getReader();

    expect(await readOrTimeout(reader)).toMatch(/^: /);
  });

  it("sends data-only SSE messages without event field", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    const raw = await readRawChunks(response, 2);
    expect(raw).toContain("data: ");
    expect(raw).not.toContain("event:");
  });

  it("tags SSE ids with a per-instance epoch", async () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});

    const handler = tm.createSSEHandler();
    const response = await handler(makeEvent());

    const raw = await readRawChunks(response, 2);
    expect(raw).toMatch(/id: [a-z0-9]+:\d+\n/);
  });

  it("supports async authorize", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler({
      authorize: async () => {
        await tick();
        return true;
      },
    });

    const response = await handler(makeEvent());
    expect(response.status).toBe(200);
  });

  describe("Last-Event-ID replay", () => {
    it("replays buffered events when client provides lastEventId", async () => {
      const tm = new TaskManager({ eventBufferSize: 100 });
      tm.register("test", async (ctx) => {
        ctx.progress("Step 1", 1, 2);
        ctx.progress("Step 2", 2, 2);
      });

      const handler = tm.createSSEHandler();
      const lastEventId = await connectAndGetLastEventId(tm, 1);

      // Start task to generate buffered events
      tm.start("test");
      await tick(50);

      // Reconnect — should replay the buffered events, not an init dump
      const response2 = await handler(makeEventWithParam({ lastEventId }));
      const replayed = await readMessages(response2, 1);
      expect(replayed[0].type).toBe("update");
    });

    // A replay is a delta, not a snapshot — a synced message would wipe the client's tasks
    it("does not send a synced message after a replay", async () => {
      const tm = new TaskManager({ eventBufferSize: 10 });
      tm.register("a", async () => {});
      const lastEventId = await connectAndGetLastEventId(tm, 1);

      const response = await tm.createSSEHandler()(makeEventWithParam({ lastEventId }));
      const reader = response.body!.getReader();

      expect(await readOrTimeout(reader)).toMatch(/^: /);
      expect(await readOrTimeout(reader)).toBe("timeout");
    });

    it("replays exactly the missed events, in order, after the ring buffer has wrapped", async () => {
      const tm = new TaskManager({ eventBufferSize: 3 });
      tm.register("test", async (ctx) => {
        ctx.progress("p1");
        ctx.progress("p2");
      });

      const handler = tm.createSSEHandler();
      // register emitted event 1; the init dump is tagged with id 1
      const lastEventId = await connectAndGetLastEventId(tm, 1);

      // Emits running (2), p1 (3), p2 (4), completed (5): buffer now holds 3, 4, 5 with ringHead > 0
      tm.start("test");
      await tick(50);

      // Client saw up to 2 — the buffer's oldest is 3, so the gap check passes
      const [epoch] = lastEventId.split(":");
      const response = await handler(makeEventWithParam({ lastEventId: `${epoch}:2` }));
      const blocks = await readBlocks(response, 3);

      expect(blocks.map((b) => b.id)).toEqual([`${epoch}:3`, `${epoch}:4`, `${epoch}:5`]);
      expect(blocks.map((b) => b.msg)).toEqual([
        {
          type: "update",
          taskId: "test",
          state: { id: "test", status: "running", progress: { message: "p1" } },
        },
        {
          type: "update",
          taskId: "test",
          state: { id: "test", status: "running", progress: { message: "p2" } },
        },
        {
          type: "update",
          taskId: "test",
          state: { id: "test", status: "completed", lastRun: expect.any(Number) },
        },
      ]);
    });

    it("falls back to init dump when buffer cannot satisfy lastEventId", async () => {
      const tm = new TaskManager({ eventBufferSize: 1 });
      tm.register("test", async (ctx) => {
        ctx.progress("p1");
        ctx.progress("p2");
        ctx.progress("p3");
      });

      const handler = tm.createSSEHandler();
      const lastEventId = await connectAndGetLastEventId(tm, 1);

      // Generate events that overflow the tiny buffer
      tm.start("test");
      await tick(50);

      // Reconnect with a lastEventId that has fallen out of the buffer
      const response = await handler(makeEventWithParam({ lastEventId }));
      const messages = await readMessages(response, 1);
      expect(messages[0].type).toBe("init");
    });

    it("falls back to init dump when lastEventId comes from a previous server process", async () => {
      // Simulate a restart: the client holds an id from an old manager instance
      const oldTm = new TaskManager({ eventBufferSize: 100 });
      oldTm.register("test", async () => {});
      const staleId = await connectAndGetLastEventId(oldTm, 1);

      const tm = new TaskManager({ eventBufferSize: 100 });
      tm.register("test", async () => {});
      tm.start("test");
      await tick(50);

      const response = await tm.createSSEHandler()(makeEventWithParam({ lastEventId: staleId }));
      const messages = await readMessages(response, 1);
      expect(messages[0]).toEqual({
        type: "init",
        task: { id: "test", status: "completed", lastRun: expect.any(Number) },
      });
    });

    it("falls back to init dump for a legacy numeric or malformed lastEventId", async () => {
      const tm = new TaskManager({ eventBufferSize: 100 });
      tm.register("test", async () => {});
      const [epoch] = (await connectAndGetLastEventId(tm, 1)).split(":");

      for (const lastEventId of ["0", "500", "abc", `${epoch}:abc`, `${epoch}:999`]) {
        const response = await tm.createSSEHandler()(makeEventWithParam({ lastEventId }));
        const messages = await readMessages(response, 1);
        expect(messages[0].type, `lastEventId=${lastEventId}`).toBe("init");
      }
    });

    it("reads Last-Event-ID from request header (SSE spec)", async () => {
      const tm = new TaskManager({ eventBufferSize: 100 });
      tm.register("test", async (ctx) => {
        ctx.progress("Step 1", 1, 2);
      });

      const handler = tm.createSSEHandler();
      const lastEventId = await connectAndGetLastEventId(tm, 1);

      // Generate buffered events
      tm.start("test");
      await tick(50);

      // Reconnect with Last-Event-ID header
      const response = await handler(makeEventWithHeader({ "Last-Event-ID": lastEventId }));
      const replayed = await readMessages(response, 1);
      expect(replayed[0].type).toBe("update");
    });
  });

  describe("lifecycle", () => {
    const subscriberCount = (tm: TaskManager) =>
      (tm as unknown as { subscribers: Set<unknown> }).subscribers.size;

    it("unsubscribes from the manager when the client disconnects", async () => {
      const tm = new TaskManager();
      tm.register("a", async () => {});

      const response = await tm.createSSEHandler()(makeEvent());
      await readMessages(response, 1);
      expect(subscriberCount(tm)).toBe(1);

      await response.body!.cancel();
      expect(subscriberCount(tm)).toBe(0);
    });

    it("closes open streams on dispose", async () => {
      const tm = new TaskManager();
      tm.register("a", async () => {});

      const response = await tm.createSSEHandler()(makeEvent());
      const reader = response.body!.getReader();
      await reader.read(); // connected comment
      await reader.read(); // init
      await reader.read(); // synced

      tm[Symbol.dispose]();

      expect(await readOrTimeout(reader)).toBe("done");
      expect(subscriberCount(tm)).toBe(0);
    });
  });

  it("does not include Connection header in response", async () => {
    const tm = new TaskManager();
    const handler = tm.createSSEHandler();

    const response = await handler(makeEvent());
    expect(response.headers.get("Connection")).toBeNull();
  });
});
