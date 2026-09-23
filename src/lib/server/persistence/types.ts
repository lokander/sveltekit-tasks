import type { TaskState } from "../../shared/types.js";

/** A value that may or may not be wrapped in a `Promise`. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Storage backend that lets task state survive server restarts. Pass one to
 * {@link TaskManager} via the `persistence` option.
 *
 * The manager keeps its in-memory state as the source of truth and uses the
 * adapter as a write-through store: `load()` is called once on construction,
 * then `save()`/`delete()` are called on status transitions and evictions.
 * Progress updates are not persisted.
 *
 * Methods may be synchronous or return a `Promise`. Async writes are
 * serialized in call order.
 */
export type PersistenceAdapter = {
  /** Load all persisted task states. Called once when the `TaskManager` is constructed. */
  load(): MaybePromise<TaskState[]>;
  /** Insert or replace the persisted state of a task. */
  save(state: TaskState): MaybePromise<void>;
  /** Remove the persisted state of a task (called on `maxHistory` eviction). */
  delete(taskId: string): MaybePromise<void>;
};
