import { describe, it, expect, vi } from "vitest";
import { TaskManager } from "./manager.js";

describe("TaskManager", () => {
  it("registers a task with pending status", () => {
    const tm = new TaskManager();
    tm.register("test", async () => {});

    const state = tm.getState("test");
    expect(state).toEqual({ id: "test", status: "pending" });
  });

  it("returns all registered task states", () => {
    const tm = new TaskManager();
    tm.register("a", async () => {});
    tm.register("b", async () => {});

    const states = tm.getAllStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns undefined for unknown task", () => {
    const tm = new TaskManager();
    expect(tm.getState("nonexistent")).toBeUndefined();
  });

  it("starts a task and transitions to running", async () => {
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const tm = new TaskManager();
    tm.register("test", handler);

    tm.start("test");

    // The task should be running (handler takes 50ms)
    const state = tm.getState("test");
    expect(state?.status).toBe("running");
    expect(handler).toHaveBeenCalledOnce();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));
    const completed = tm.getState("test");
    expect(completed?.status).toBe("completed");
    expect(completed?.status === "completed" && completed.lastRun).toBeTypeOf("number");
  });

  it("does not start an already running task", async () => {
    const handler = vi.fn(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const tm = new TaskManager({ debug: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    tm.register("test", handler);

    tm.start("test");
    tm.start("test"); // no-op

    expect(handler).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("reports progress through context", async () => {
    const updates: string[] = [];
    const tm = new TaskManager();

    tm.register("test", async (ctx) => {
      ctx.progress("Step 1", 1, 3);
      ctx.progress("Step 2", 2, 3);
      ctx.progress("Step 3", 3, 3);
    });

    tm.subscribe((event) => {
      if (event.state.status === "running" && event.state.progress) {
        updates.push(event.state.progress.message);
      }
    });

    tm.start("test");
    // Wait for the sync handler to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(updates).toContain("Step 1");
    expect(updates).toContain("Step 2");
    expect(updates).toContain("Step 3");
  });

  it("cancels a running task", async () => {
    let wasCanceled = false;
    const tm = new TaskManager();

    tm.register("test", async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      wasCanceled = ctx.isCanceled();
    });

    tm.start("test");
    tm.cancel("test");

    const state = tm.getState("test");
    expect(state?.status).toBe("canceled");

    // Wait for handler to check cancellation
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wasCanceled).toBe(true);
  });

  it("provides an AbortSignal via context", async () => {
    let signalAborted = false;
    const tm = new TaskManager();

    tm.register("test", async (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        signalAborted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    tm.start("test");
    tm.cancel("test");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signalAborted).toBe(true);
  });

  it("transitions to error on handler failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tm = new TaskManager();
    tm.register("test", async () => {
      throw new Error("boom");
    });

    tm.start("test");
    // Wait for the async handler to complete and error to be caught
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = tm.getState("test");
    expect(state?.status).toBe("error");
    expect(state?.status === "error" && state.error).toBe("boom");
    expect(state?.status === "error" && state.lastRun).toBeTypeOf("number");
    errorSpy.mockRestore();
  });

  it("subscribe returns an unsubscribe function", () => {
    const tm = new TaskManager();
    const callback = vi.fn();

    const unsub = tm.subscribe(callback);
    tm.register("test", async () => {});

    unsub();

    // After unsubscribing, callback should not be called for new events
    // (register doesn't notify, but start does)
    expect(callback).not.toHaveBeenCalled();
  });

  it("notifies subscribers on state changes", async () => {
    const events: Array<{ taskId: string; status: string }> = [];
    const tm = new TaskManager();

    tm.register("test", async () => {});
    tm.subscribe((event) => events.push({ taskId: event.taskId, status: event.state.status }));

    tm.start("test");
    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].status).toBe("running");
    expect(events[events.length - 1].status).toBe("completed");
  });

  it("does nothing when starting an unregistered task", () => {
    const tm = new TaskManager();
    // Should not throw
    tm.start("nonexistent");
    expect(tm.getState("nonexistent")).toBeUndefined();
  });

  it("does nothing when canceling an unregistered task", () => {
    const tm = new TaskManager();
    // Should not throw
    tm.cancel("nonexistent");
    expect(tm.getState("nonexistent")).toBeUndefined();
  });

  it("ignores progress updates after cancellation", async () => {
    const progressMessages: string[] = [];
    const tm = new TaskManager();

    tm.register("test", async (ctx) => {
      ctx.progress("Before cancel", 1, 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // This progress call should be ignored after cancel
      ctx.progress("After cancel", 2, 2);
    });

    tm.subscribe((event) => {
      if (event.state.status === "running" && event.state.progress) {
        progressMessages.push(event.state.progress.message);
      }
    });

    tm.start("test");
    tm.cancel("test");

    // Wait for handler to finish
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(progressMessages).toContain("Before cancel");
    expect(progressMessages).not.toContain("After cancel");
  });

  it("does not transition to error after cancellation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tm = new TaskManager();

    tm.register("test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("should be ignored");
    });

    tm.start("test");
    tm.cancel("test");

    // Wait for handler to throw
    await new Promise((resolve) => setTimeout(resolve, 100));

    const state = tm.getState("test");
    expect(state?.status).toBe("canceled");
    errorSpy.mockRestore();
  });

  it("can restart a canceled task", async () => {
    const tm = new TaskManager();

    tm.register("test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    tm.start("test");
    tm.cancel("test");
    expect(tm.getState("test")?.status).toBe("canceled");

    // Restart the canceled task
    tm.start("test");
    expect(tm.getState("test")?.status).toBe("running");

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tm.getState("test")?.status).toBe("completed");
  });

  it("logs debug warnings when debug option is enabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tm = new TaskManager({ debug: true });

    tm.start("nonexistent");
    expect(warnSpy).toHaveBeenCalledWith('Task "nonexistent" not found');
    warnSpy.mockRestore();
  });

  it("does not log debug warnings when debug option is disabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tm = new TaskManager();

    tm.start("nonexistent");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("throws on duplicate registration", () => {
    const tm = new TaskManager();
    tm.register("test", async () => {});

    expect(() => tm.register("test", async () => {})).toThrowError(
      'Task "test" is already registered',
    );
  });

  it("old run does not clobber state when task is restarted before completion", async () => {
    let firstRunResolve: () => void;
    let runCount = 0;

    const tm = new TaskManager();
    tm.register("test", async () => {
      runCount++;
      if (runCount === 1) {
        // First run: hang until we resolve it manually
        await new Promise<void>((resolve) => {
          firstRunResolve = resolve;
        });
      }
      // Second run: completes immediately
    });

    // Start first run
    tm.start("test");
    expect(tm.getState("test")?.status).toBe("running");

    // Cancel and immediately restart (second run)
    tm.cancel("test");
    tm.start("test");

    // Second run completes instantly
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tm.getState("test")?.status).toBe("completed");

    // Now let the first run finish — its finally block should NOT delete the abort controller
    firstRunResolve!();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // State should still be "completed" from the second run, not overwritten
    expect(tm.getState("test")?.status).toBe("completed");
  });

  describe("maxHistory", () => {
    it("evicts oldest terminal tasks when limit is exceeded", async () => {
      const tm = new TaskManager({ maxHistory: 2 });

      tm.register("a", async () => {});
      tm.register("b", async () => {});
      tm.register("c", async () => {});

      // Complete tasks in order: a, b, c
      tm.start("a");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tm.getState("a")?.status).toBe("completed");

      tm.start("b");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tm.getState("b")?.status).toBe("completed");

      tm.start("c");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tm.getState("c")?.status).toBe("completed");

      // "a" should have been evicted (oldest), b and c remain
      expect(tm.getState("a")).toBeUndefined();
      expect(tm.getState("b")?.status).toBe("completed");
      expect(tm.getState("c")?.status).toBe("completed");
      expect(tm.getAllStates()).toHaveLength(2);
    });

    it("does not evict running or pending tasks", async () => {
      const tm = new TaskManager({ maxHistory: 1 });

      tm.register("running-task", async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      tm.register("pending-task", async () => {});
      tm.register("a", async () => {});
      tm.register("b", async () => {});

      tm.start("running-task"); // stays running

      tm.start("a");
      await new Promise((resolve) => setTimeout(resolve, 50));

      tm.start("b");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // "a" should be evicted, "b" remains as the 1 allowed terminal task
      // running-task and pending-task should NOT be evicted
      expect(tm.getState("running-task")?.status).toBe("running");
      expect(tm.getState("pending-task")?.status).toBe("pending");
      expect(tm.getState("a")).toBeUndefined();
      expect(tm.getState("b")?.status).toBe("completed");
    });

    it("does not evict when maxHistory is not set", async () => {
      const tm = new TaskManager();

      for (let i = 0; i < 10; i++) {
        tm.register(`task-${i}`, async () => {});
        tm.start(`task-${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tm.getAllStates()).toHaveLength(10);
    });
  });

  describe("timeout", () => {
    it("auto-transitions to timed_out after timeout", async () => {
      const tm = new TaskManager();

      tm.register(
        "slow",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        { timeout: 50 },
      );

      tm.start("slow");
      expect(tm.getState("slow")?.status).toBe("running");

      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = tm.getState("slow");
      expect(state?.status).toBe("timed_out");
      expect(state?.status === "timed_out" && state.lastRun).toBeTypeOf("number");
    });

    it("aborts the signal on timeout", async () => {
      let signalAborted = false;
      const tm = new TaskManager();

      tm.register(
        "slow",
        async (ctx) => {
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        { timeout: 50 },
      );

      tm.start("slow");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(signalAborted).toBe(true);
    });

    it("clears timeout on normal completion", async () => {
      const tm = new TaskManager();

      tm.register("fast", async () => {}, { timeout: 500 });

      tm.start("fast");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(tm.getState("fast")?.status).toBe("completed");

      // Wait past the timeout — should NOT transition to timed_out
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(tm.getState("fast")?.status).toBe("completed");
    });

    it("clears timeout on manual cancel", async () => {
      const tm = new TaskManager();

      tm.register(
        "test",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        { timeout: 200 },
      );

      tm.start("test");
      tm.cancel("test");
      expect(tm.getState("test")?.status).toBe("canceled");

      // Wait past the timeout — should stay canceled, not timed_out
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tm.getState("test")?.status).toBe("canceled");
    });

    it("does not transition to error after timeout", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const tm = new TaskManager();

      tm.register(
        "test",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw new Error("should be ignored after timeout");
        },
        { timeout: 30 },
      );

      tm.start("test");
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(tm.getState("test")?.status).toBe("timed_out");
      errorSpy.mockRestore();
    });
  });

  describe("event buffer", () => {
    it("assigns incrementing eventIds to updates", () => {
      const tm = new TaskManager({ eventBufferSize: 100 });
      const eventIds: number[] = [];

      tm.register("test", async () => {});
      tm.subscribe((event) => eventIds.push(event.eventId));

      tm.start("test");

      expect(eventIds.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < eventIds.length; i++) {
        expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1]);
      }
    });
  });

  it("stale run progress does not leak into restarted task", async () => {
    const progressMessages: string[] = [];
    let firstRunContinue: () => void;

    const tm = new TaskManager();
    let runCount = 0;
    tm.register("test", async (ctx) => {
      runCount++;
      if (runCount === 1) {
        // First run: report progress, then hang
        ctx.progress("Run 1 before");
        await new Promise<void>((resolve) => {
          firstRunContinue = resolve;
        });
        // This progress should be ignored — stale run
        ctx.progress("Run 1 after restart");
      } else {
        // Second run: report progress immediately
        ctx.progress("Run 2");
      }
    });

    tm.subscribe((event) => {
      if (event.state.status === "running" && event.state.progress) {
        progressMessages.push(event.state.progress.message);
      }
    });

    // Start first run
    tm.start("test");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Cancel and restart (second run)
    tm.cancel("test");
    tm.start("test");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Let first run continue — its progress() should be ignored
    firstRunContinue!();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(progressMessages).toContain("Run 1 before");
    expect(progressMessages).toContain("Run 2");
    expect(progressMessages).not.toContain("Run 1 after restart");
  });

  describe("dispose", () => {
    it("aborts running tasks and clears all state", async () => {
      let signalAborted = false;
      const tm = new TaskManager();

      tm.register("test", async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      tm.start("test");
      expect(tm.getState("test")?.status).toBe("running");

      tm[Symbol.dispose]();

      expect(signalAborted).toBe(true);
      expect(tm.getAllStates()).toHaveLength(0);
      expect(tm.getState("test")).toBeUndefined();
    });

    it("clears subscribers so no events fire after dispose", () => {
      const tm = new TaskManager();
      const callback = vi.fn();
      tm.subscribe(callback);

      tm[Symbol.dispose]();

      // Re-register and start — subscriber should not be called
      tm.register("test", async () => {});
      tm.start("test");
      expect(callback).not.toHaveBeenCalled();
    });

    it("clears pending timeouts", async () => {
      const tm = new TaskManager();
      tm.register(
        "test",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        { timeout: 50 },
      );

      tm.start("test");
      tm[Symbol.dispose]();

      // Wait past the timeout — should not throw or transition
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(tm.getState("test")).toBeUndefined();
    });
  });
});
