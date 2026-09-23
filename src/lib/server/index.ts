export { TaskManager, INTERRUPTED_ERROR } from "./manager.js";
export { sqliteAdapter } from "./persistence/sqlite.js";
export type {
  TaskHandler,
  TaskRegisterOptions,
  TaskUpdateEvent,
  TaskManagerOptions,
  TaskSSEHandlerOptions,
} from "./manager.js";
export type { PersistenceAdapter, MaybePromise } from "./persistence/types.js";
export type {
  SqliteAdapterOptions,
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from "./persistence/sqlite.js";
