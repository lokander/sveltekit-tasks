import type { TaskState, TaskStatus } from "../../shared/types.js";
import type { PersistenceAdapter } from "./types.js";

/** Parameter value accepted by the SQLite drivers supported by {@link sqliteAdapter}. */
export type SqliteValue = string | number | bigint | null;

/** Minimal prepared-statement interface shared by `better-sqlite3`, `node:sqlite` and `bun:sqlite`. */
export type SqliteStatement = {
  run(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
};

/** Minimal database interface shared by `better-sqlite3`, `node:sqlite` and `bun:sqlite`. */
export type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
};

/** Options for {@link sqliteAdapter}. */
export type SqliteAdapterOptions = {
  /** Name of the table used to store task state. Created if it doesn't exist. @default "sveltekit_tasks" */
  tableName?: string;
};

type Row = {
  id: string;
  status: string;
  last_run: number | bigint | null;
  error: string | null;
};

const STATUSES = new Set<TaskStatus>([
  "pending",
  "running",
  "completed",
  "error",
  "canceled",
  "timed_out",
]);

/**
 * Persist task state to SQLite. Works with any synchronous driver exposing
 * `exec()` and `prepare().run()/.all()` — `better-sqlite3`, `node:sqlite`
 * (`DatabaseSync`) and `bun:sqlite` all qualify. The database connection is
 * owned by the caller; the adapter never closes it.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { TaskManager, sqliteAdapter } from "sveltekit-tasks/server";
 *
 * const db = new DatabaseSync("tasks.db");
 * export const tasks = new TaskManager({ persistence: sqliteAdapter(db) });
 * ```
 */
export function sqliteAdapter(
  db: SqliteDatabase,
  options: SqliteAdapterOptions = {},
): PersistenceAdapter {
  const table = options.tableName ?? "sveltekit_tasks";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid SQLite table name "${table}"`);
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_run INTEGER,
      error TEXT,
      updated_at INTEGER NOT NULL
    )`,
  );

  const selectAll = db.prepare(`SELECT id, status, last_run, error FROM ${table}`);
  const upsert = db.prepare(
    `INSERT INTO ${table} (id, status, last_run, error, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       last_run = excluded.last_run,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  );
  const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);

  return {
    load() {
      const states: TaskState[] = [];
      for (const row of selectAll.all() as Row[]) {
        const state = rowToState(row);
        if (state) states.push(state);
      }
      return states;
    },
    save(state) {
      const lastRun = "lastRun" in state ? state.lastRun : null;
      const error = state.status === "error" ? state.error : null;
      upsert.run(state.id, state.status, lastRun, error, Date.now());
    },
    delete(taskId) {
      remove.run(taskId);
    },
  };
}

function rowToState(row: Row): TaskState | undefined {
  const { id } = row;
  const status = row.status as TaskStatus;
  if (!STATUSES.has(status)) return undefined;

  const lastRun = Number(row.last_run ?? 0);
  switch (status) {
    case "pending":
    case "running":
      return { id, status };
    case "error":
      return { id, status, lastRun, error: row.error ?? "Unknown error" };
    default:
      return { id, status, lastRun };
  }
}
