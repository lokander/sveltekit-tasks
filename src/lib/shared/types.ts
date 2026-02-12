/** Lifecycle status of a managed task. */
export type TaskStatus = "pending" | "running" | "completed" | "error" | "canceled" | "timed_out";

/** Progress information reported by a running task via {@link TaskContext.progress}. */
export type TaskProgress = {
  /** Human-readable description of what the task is currently doing. */
  message: string;
  /** Current progress value (e.g. items processed). */
  current?: number;
  /** Total expected value (e.g. total items). Enables percentage calculation when paired with `current`. */
  total?: number;
};

/**
 * Snapshot of a task's current state, streamed to clients via SSE.
 *
 * This is a discriminated union on `status` — narrow via `task.status === "running"` etc.
 * to access status-specific fields like `progress`, `error`, or `lastRun`.
 */
export type TaskState =
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "pending";
    }
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "running";
      /** Latest progress of the task. Initialized by the manager, then updated by the handler via {@link TaskContext.progress}. */
      progress?: TaskProgress;
    }
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "completed";
      /** Epoch timestamp (ms) of the last completion. */
      lastRun: number;
    }
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "error";
      /** Epoch timestamp (ms) of the last failure. */
      lastRun: number;
      /** Error message from the most recent failed run. */
      error: string;
    }
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "canceled";
      /** Epoch timestamp (ms) of the last cancellation. */
      lastRun: number;
    }
  | {
      /** Unique identifier matching the id passed to {@link TaskManager.register}. */ id: string;
      status: "timed_out";
      /** Epoch timestamp (ms) when the task timed out. */
      lastRun: number;
    };

/**
 * Context object passed to a {@link TaskHandler}. Provides progress reporting,
 * cancellation checking, and an `AbortSignal` for cooperative cancellation.
 */
export type TaskContext = {
  /** Report progress to subscribers. Call as often as needed — each call emits an SSE message. */
  progress: (message: string, current?: number, total?: number) => void;
  /** Returns `true` if the task has been canceled. Check this in loops to exit early. */
  isCanceled: () => boolean;
  /** The raw `AbortSignal` — pass to `fetch()`, `setTimeout` wrappers, etc. for cooperative cancellation. */
  signal: AbortSignal;
};

/**
 * Discriminated union of SSE message types sent from server to client.
 *
 * - `"init"` — sent once per task when a client connects, carrying the full current state.
 * - `"update"` — sent whenever a task's state changes after the initial snapshot.
 */
export type TaskSSEMessage =
  | { type: "init"; task: TaskState }
  | { type: "update"; taskId: string; state: TaskState };
