import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TaskManager, INTERRUPTED_ERROR } from "./manager.js";
import { sqliteAdapter } from "./persistence/sqlite.js";
import type { PersistenceAdapter } from "./persistence/types.js";
import type { TaskState } from "../shared/types.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryAdapter(initial: TaskState[] = []) {
  const rows = new Map(initial.map((s) => [s.id, s]));
  const adapter = {
    rows,
    load: vi.fn(() => [...rows.values()]),
    save: vi.fn((state: TaskState) => void rows.set(state.id, state)),
    delete: vi.fn((id: string) => void rows.delete(id)),
  } satisfies PersistenceAdapter & { rows: Map<string, TaskState> };
  return adapter;
}

describe("TaskManager persistence", () => {
  it("restores terminal state for tasks registered after load", () => {
    const adapter = memoryAdapter([{ id: "a", status: "completed", lastRun: 123 }]);
    const tm = new TaskManager({ persistence: adapter });
    tm.register("a", async () => {});

    expect(tm.getState("a")).toEqual({ id: "a", status: "completed", lastRun: 123 });
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it("does not expose persisted state for unregistered tasks", () => {
    const tm = new TaskManager({
      persistence: memoryAdapter([{ id: "a", status: "completed", lastRun: 1 }]),
    });
    expect(tm.getAllStates()).toEqual([]);
  });

  it("persists status transitions but not progress", async () => {
    const adapter = memoryAdapter();
    const tm = new TaskManager({ persistence: adapter });
    tm.register("a", async (ctx) => {
      ctx.progress("one");
      ctx.progress("two");
    });

    tm.start("a");
    await tick();

    expect(adapter.save.mock.calls.map(([s]) => s.status)).toEqual(["running", "completed"]);
    expect(adapter.rows.get("a")?.status).toBe("completed");
  });

  it("marks interrupted tasks as error", () => {
    const adapter = memoryAdapter([{ id: "a", status: "running" }]);
    const tm = new TaskManager({ persistence: adapter });
    tm.register("a", async () => {});

    const state = tm.getState("a");
    expect(state?.status === "error" && state.error).toBe(INTERRUPTED_ERROR);
    expect(adapter.rows.get("a")?.status).toBe("error");
  });

  it("restarts interrupted tasks when restartInterrupted is set", () => {
    const handler = vi.fn(async () => {});
    const tm = new TaskManager({
      persistence: memoryAdapter([{ id: "a", status: "running" }]),
    });
    tm.register("a", handler, { restartInterrupted: true });

    expect(tm.getState("a")?.status).toBe("running");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("hydrates registered tasks when an async load resolves", async () => {
    const adapter: PersistenceAdapter = {
      load: async () => [{ id: "a", status: "error", lastRun: 5, error: "boom" }],
      save: vi.fn(),
      delete: vi.fn(),
    };
    const tm = new TaskManager({ persistence: adapter });
    tm.register("a", async () => {});
    const events: string[] = [];
    tm.subscribe((e) => events.push(e.state.status));

    expect(tm.getState("a")?.status).toBe("pending");
    await tm.ready;

    expect(tm.getState("a")).toEqual({ id: "a", status: "error", lastRun: 5, error: "boom" });
    expect(events).toEqual(["error"]);
  });

  it("does not overwrite tasks started before an async load resolves", async () => {
    const tm = new TaskManager({
      persistence: {
        load: async () => [{ id: "a", status: "completed", lastRun: 1 }],
        save: vi.fn(),
        delete: vi.fn(),
      },
    });
    tm.register("a", () => new Promise(() => {}));
    tm.start("a");
    await tm.ready;

    expect(tm.getState("a")?.status).toBe("running");
  });

  it("serializes async writes in call order", async () => {
    const order: string[] = [];
    const adapter: PersistenceAdapter = {
      load: () => [],
      save: async (state) => {
        await tick(state.status === "running" ? 20 : 0);
        order.push(state.status);
      },
      delete: async () => {},
    };
    const tm = new TaskManager({ persistence: adapter });
    tm.register("a", async () => {});
    tm.start("a");
    await tick();
    await tm.flush();

    expect(order).toEqual(["running", "completed"]);
  });

  it("logs and continues when a write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tm = new TaskManager({
      persistence: {
        load: () => [],
        save: () => {
          throw new Error("disk full");
        },
        delete: () => {},
      },
    });
    tm.register("a", async () => {});
    tm.start("a");
    await tick();

    expect(tm.getState("a")?.status).toBe("completed");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("deletes evicted tasks from the adapter, including unregistered ones", async () => {
    const adapter = memoryAdapter([{ id: "old", status: "completed", lastRun: 1 }]);
    const tm = new TaskManager({ persistence: adapter, maxHistory: 1 });
    tm.register("a", async () => {});
    tm.start("a");
    await tick();

    expect(adapter.delete).toHaveBeenCalledWith("old");
    expect([...adapter.rows.keys()]).toEqual(["a"]);
  });
});

describe("sqliteAdapter", () => {
  it("round-trips task state across manager instances", async () => {
    const db = new DatabaseSync(":memory:");

    const first = new TaskManager({ persistence: sqliteAdapter(db) });
    first.register("ok", async () => {});
    first.register("fail", async () => {
      throw new Error("boom");
    });
    first.register("stuck", () => new Promise(() => {}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    first.start("ok");
    first.start("fail");
    first.start("stuck");
    await tick();
    vi.restoreAllMocks();

    const second = new TaskManager({ persistence: sqliteAdapter(db) });
    second.register("ok", async () => {});
    second.register("fail", async () => {});
    second.register("stuck", async () => {});

    expect(second.getState("ok")).toMatchObject({ status: "completed" });
    expect(second.getState("fail")).toMatchObject({ status: "error", error: "boom" });
    expect(second.getState("stuck")).toMatchObject({ status: "error", error: INTERRUPTED_ERROR });
  });

  it("deletes rows", () => {
    const db = new DatabaseSync(":memory:");
    const adapter = sqliteAdapter(db, { tableName: "jobs" });
    adapter.save({ id: "a", status: "canceled", lastRun: 7 });
    expect(adapter.load()).toEqual([{ id: "a", status: "canceled", lastRun: 7 }]);

    adapter.delete("a");
    expect(adapter.load()).toEqual([]);
  });

  it("rejects unsafe table names", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => sqliteAdapter(db, { tableName: "x; DROP TABLE y" })).toThrow();
  });
});
