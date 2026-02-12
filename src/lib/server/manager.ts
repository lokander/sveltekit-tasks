import type { RequestEvent } from "@sveltejs/kit";
import type { TaskContext, TaskSSEMessage, TaskState } from "../shared/types.js";

/**
 * A function that performs the actual work of a task. Receives a {@link TaskContext}
 * for progress reporting and cancellation. Must return `Promise<void>` — results
 * should be written to a database/file/etc. by the handler itself.
 */
export type TaskHandler = (ctx: TaskContext) => Promise<void>;

/** Options passed to {@link TaskManager.register} for per-task configuration. */
export type TaskRegisterOptions = {
  /** Auto-cancel the task after this many milliseconds. The task transitions to `"timed_out"` status. */
  timeout?: number;
};

/** @internal */
export type RegisteredTask = {
  id: string;
  handler: TaskHandler;
  timeout?: number;
};

/** Payload delivered to {@link TaskManager.subscribe} listeners on every state change. */
export type TaskUpdateEvent = {
  taskId: string;
  state: TaskState;
  /** Monotonically increasing event identifier. Used for SSE replay via `Last-Event-ID`. */
  eventId: number;
};

/** Options for {@link TaskManager.createSSEHandler}. */
export type TaskSSEHandlerOptions = {
  /** Optional authorization check. Return `false` (or a `Promise<false>`) to respond with 403. */
  authorize?: (event: RequestEvent) => boolean | Promise<boolean>;
  /** Interval in ms between SSE heartbeat comments. Keeps the connection alive through proxies. @default 30_000 */
  heartbeatInterval?: number;
};

/** Options for the {@link TaskManager} constructor. */
export type TaskManagerOptions = {
  /** When `true`, logs warnings to the console for no-op calls (e.g. starting an unregistered or already-running task). */
  debug?: boolean;
  /**
   * Maximum number of tasks in terminal states (completed, error, canceled, timed_out) to keep.
   * When exceeded, the oldest terminal tasks (by `lastRun`) are evicted from all internal maps.
   * `undefined` or `0` disables eviction.
   */
  maxHistory?: number;
  /**
   * Number of recent state-change events to buffer for `Last-Event-ID` replay.
   * When a client reconnects with a `lastEventId`, buffered events are replayed
   * instead of sending a full init dump. `0` (default) disables buffering.
   */
  eventBufferSize?: number;
};

const TERMINAL_STATUSES = new Set(["completed", "error", "canceled", "timed_out"]);

/**
 * In-memory manager for background tasks. Handles registration, execution,
 * cancellation, progress reporting, and pub-sub notifications.
 *
 * State is held in memory and is **not** persisted — a server restart loses all
 * state and running tasks. Only suitable for single-process deployments.
 *
 * @example
 * ```ts
 * const tasks = new TaskManager({ debug: true });
 *
 * tasks.register("import-data", async (ctx) => {
 *   for (let i = 0; i < 100; i++) {
 *     if (ctx.isCanceled()) return;
 *     ctx.progress("Processing...", i + 1, 100);
 *     await doWork(i);
 *   }
 * });
 *
 * tasks.start("import-data");
 * ```
 */
export class TaskManager {
  private tasks = new Map<string, RegisteredTask>();
  private state = new Map<string, TaskState>();
  private subscribers = new Set<(event: TaskUpdateEvent) => void>();
  private abortControllers = new Map<string, AbortController>();
  private runGeneration = new Map<string, number>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private debug: boolean;
  private maxHistory: number;
  private eventBufferSize: number;
  private nextEventId = 1;
  private eventBuffer: TaskUpdateEvent[] = [];
  private ringHead = 0;

  constructor(options: TaskManagerOptions = {}) {
    this.debug = options.debug ?? false;
    this.maxHistory = options.maxHistory ?? 0;
    this.eventBufferSize = options.eventBufferSize ?? 0;
  }

  /**
   * Register a task with a unique id and a handler function. Initializes the task in `"pending"` status.
   *
   * @throws {Error} If a task with the same id is already registered.
   * @param options - Optional per-task configuration (e.g. `timeout`).
   */
  register(taskId: string, handler: TaskHandler, options?: TaskRegisterOptions): void {
    if (this.tasks.has(taskId)) {
      throw new Error(`Task "${taskId}" is already registered`);
    }
    this.tasks.set(taskId, { id: taskId, handler, timeout: options?.timeout });
    this.state.set(taskId, { id: taskId, status: "pending" });
  }

  /**
   * Start a registered task. Fire-and-forget — the handler runs in the background.
   * No-op if the task is already running or the id is not registered.
   */
  start(taskId: string): void {
    const task = this.tasks.get(taskId);
    const currentState = this.state.get(taskId);

    if (!task || !currentState) {
      if (this.debug) console.warn(`Task "${taskId}" not found`);
      return;
    }

    if (currentState.status === "running") {
      if (this.debug) console.warn(`Task "${taskId}" is already running`);
      return;
    }

    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);

    const generation = (this.runGeneration.get(taskId) ?? 0) + 1;
    this.runGeneration.set(taskId, generation);

    // Clear any existing timeout from a previous run
    this.clearTimeout(taskId);

    this.setState(taskId, { id: taskId, status: "running", progress: { message: "Starting..." } });

    // Set up auto-timeout if configured
    if (task.timeout) {
      const timeoutId = setTimeout(() => {
        const state = this.state.get(taskId);
        if (state?.status !== "running") return;

        const controller = this.abortControllers.get(taskId);
        controller?.abort();
        this.abortControllers.delete(taskId);
        this.timeouts.delete(taskId);

        this.setState(taskId, { id: taskId, status: "timed_out", lastRun: Date.now() });
      }, task.timeout);
      this.timeouts.set(taskId, timeoutId);
    }

    const isStale = () => this.runGeneration.get(taskId) !== generation;

    const ctx: TaskContext = {
      progress: (message: string, current?: number, total?: number) => {
        if (isStale()) return;
        const state = this.state.get(taskId);
        if (state?.status !== "running") return;
        this.setState(taskId, {
          id: taskId,
          status: "running",
          progress: { message, current, total },
        });
      },
      isCanceled: () => abortController.signal.aborted,
      signal: abortController.signal,
    };

    this.runTask(task, ctx, taskId, isStale);
  }

  /** Cancel a running task by aborting its `AbortController`. No-op if the task is not running. */
  cancel(taskId: string): void {
    const controller = this.abortControllers.get(taskId);
    if (!controller) return;

    controller.abort();
    this.abortControllers.delete(taskId);
    this.clearTimeout(taskId);

    this.setState(taskId, { id: taskId, status: "canceled", lastRun: Date.now() });
  }

  /** Get the current state of a single task, or `undefined` if the id is not registered. */
  getState(taskId: string): TaskState | undefined {
    return this.state.get(taskId);
  }

  /** Get the current state of all registered tasks. */
  getAllStates(): TaskState[] {
    return Array.from(this.state.values());
  }

  /**
   * Subscribe to task state changes. The callback fires on every state update
   * (status transitions, progress reports, etc.).
   *
   * @returns An unsubscribe function.
   */
  subscribe(callback: (event: TaskUpdateEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Create a SvelteKit `GET` request handler that streams task state via Server-Sent Events.
   *
   * On connection the handler sends an `"init"` message for every registered task,
   * then streams `"update"` messages as task state changes. A heartbeat comment
   * (`: heartbeat`) is sent periodically to keep the connection alive.
   *
   * When the client reconnects with a `Last-Event-ID` header (per the SSE spec)
   * or a `lastEventId` query parameter (used by the built-in client hook) and
   * buffering is enabled (`eventBufferSize > 0`), missed events are replayed
   * instead of sending a full init dump.
   *
   * @example
   * ```ts
   * // src/routes/tasks/sse/+server.ts
   * import { tasks } from "$lib/server/my-tasks.js";
   *
   * export const GET = tasks.createSSEHandler({
   *   authorize: (event) => event.locals.user?.isAdmin,
   * });
   * ```
   */
  createSSEHandler(options: TaskSSEHandlerOptions = {}) {
    const { authorize, heartbeatInterval = 30_000 } = options;

    return async (event: RequestEvent): Promise<Response> => {
      if (authorize) {
        const allowed = await authorize(event);
        if (!allowed) {
          return new Response("Forbidden", { status: 403 });
        }
      }

      const lastEventIdRaw =
        event.request.headers.get("Last-Event-ID") ?? event.url.searchParams.get("lastEventId");
      const lastEventId = lastEventIdRaw ? Number(lastEventIdRaw) : undefined;

      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const stream = new ReadableStream({
        start: (controller) => {
          let replayed = false;

          // Attempt replay from buffer if client provided a lastEventId
          if (lastEventId !== undefined && !Number.isNaN(lastEventId)) {
            const buffered = this.getEventsSince(lastEventId);
            if (buffered !== undefined) {
              replayed = true;
              for (const evt of buffered) {
                const msg: TaskSSEMessage = {
                  type: "update",
                  taskId: evt.taskId,
                  state: evt.state,
                };
                controller.enqueue(
                  encoder.encode(`id: ${evt.eventId}\ndata: ${JSON.stringify(msg)}\n\n`),
                );
              }
            }
          }

          // Fall back to full init dump if replay wasn't possible
          if (!replayed) {
            const currentEventId = this.getCurrentEventId();
            for (const task of this.getAllStates()) {
              const msg: TaskSSEMessage = { type: "init", task };
              controller.enqueue(
                encoder.encode(`id: ${currentEventId}\ndata: ${JSON.stringify(msg)}\n\n`),
              );
            }
          }

          // Subscribe to live updates
          unsubscribe = this.subscribe((evt) => {
            try {
              const msg: TaskSSEMessage = {
                type: "update",
                taskId: evt.taskId,
                state: evt.state,
              };
              controller.enqueue(
                encoder.encode(`id: ${evt.eventId}\ndata: ${JSON.stringify(msg)}\n\n`),
              );
            } catch {
              clearInterval(heartbeat);
              unsubscribe?.();
            }
          });

          // Heartbeat to keep connection alive
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`));
            } catch {
              clearInterval(heartbeat);
              unsubscribe?.();
            }
          }, heartbeatInterval);
        },
        cancel() {
          clearInterval(heartbeat);
          unsubscribe?.();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    };
  }

  private getCurrentEventId(): number {
    return this.nextEventId - 1;
  }

  private getEventsSince(lastEventId: number): TaskUpdateEvent[] | undefined {
    if (this.eventBufferSize === 0) return undefined;
    if (this.eventBuffer.length === 0) return [];

    const len = this.eventBuffer.length;
    const oldestIdx = len < this.eventBufferSize ? 0 : this.ringHead;
    const oldest = this.eventBuffer[oldestIdx];
    if (lastEventId < oldest.eventId - 1) return undefined; // gap — can't serve

    const result: TaskUpdateEvent[] = [];
    for (let i = 0; i < len; i++) {
      const event = this.eventBuffer[(oldestIdx + i) % len];
      if (event.eventId > lastEventId) {
        result.push(event);
      }
    }
    return result;
  }

  private async runTask(
    task: RegisteredTask,
    ctx: TaskContext,
    taskId: string,
    isStale: () => boolean,
  ): Promise<void> {
    try {
      await task.handler(ctx);

      if (!ctx.isCanceled() && !isStale()) {
        this.setState(taskId, { id: taskId, status: "completed", lastRun: Date.now() });
      }
    } catch (error) {
      if (!ctx.isCanceled() && !isStale()) {
        console.error(`Task "${taskId}" failed:`, error);
        this.setState(taskId, {
          id: taskId,
          status: "error",
          lastRun: Date.now(),
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    } finally {
      if (!isStale()) {
        this.abortControllers.delete(taskId);
        this.clearTimeout(taskId);
      }
    }
  }

  private setState(taskId: string, newState: TaskState): void {
    const current = this.state.get(taskId);
    if (!current) return;

    // Reject stale updates to externally-terminated tasks (allow restart or same-status)
    if (
      (current.status === "canceled" || current.status === "timed_out") &&
      newState.status !== current.status &&
      newState.status !== "running"
    )
      return;

    this.state.set(taskId, newState);

    const eventId = this.nextEventId++;
    const event: TaskUpdateEvent = { taskId, state: newState, eventId };

    if (this.eventBufferSize > 0) {
      if (this.eventBuffer.length < this.eventBufferSize) {
        this.eventBuffer.push(event);
      } else {
        this.eventBuffer[this.ringHead] = event;
        this.ringHead = (this.ringHead + 1) % this.eventBufferSize;
      }
    }

    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error("Error in task subscriber:", error);
      }
    }

    if (TERMINAL_STATUSES.has(newState.status)) {
      this.evictOldTasks();
    }
  }

  private evictOldTasks(): void {
    if (!this.maxHistory) return;

    const terminalTasks: Array<{ id: string; lastRun: number }> = [];

    for (const [id, s] of this.state) {
      if (TERMINAL_STATUSES.has(s.status) && "lastRun" in s) {
        terminalTasks.push({ id, lastRun: s.lastRun });
      }
    }

    if (terminalTasks.length <= this.maxHistory) return;

    terminalTasks.sort((a, b) => a.lastRun - b.lastRun);
    const toEvict = terminalTasks.slice(0, terminalTasks.length - this.maxHistory);

    for (const { id } of toEvict) {
      this.tasks.delete(id);
      this.state.delete(id);
      this.abortControllers.delete(id);
      this.runGeneration.delete(id);
      this.timeouts.delete(id);
    }
  }

  /**
   * Dispose of the task manager, releasing all resources. Aborts all running
   * tasks, clears all timeouts, and removes all subscribers. No events are
   * emitted during disposal.
   *
   * Can be used with the `using` keyword: `using tasks = new TaskManager();`
   */
  [Symbol.dispose](): void {
    this.subscribers.clear();

    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();

    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();

    this.tasks.clear();
    this.state.clear();
    this.runGeneration.clear();
    this.eventBuffer = [];
    this.ringHead = 0;
  }

  private clearTimeout(taskId: string): void {
    const timeout = this.timeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(taskId);
    }
  }
}
