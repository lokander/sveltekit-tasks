# sveltekit-tasks

Background task runner for SvelteKit with real-time progress streaming via Server-Sent Events (SSE).

> **Heads up:** This is an in-memory, single-process task manager. It's designed as an easy drop-in for small self-hosted projects — not for production systems that need horizontal scaling or persistence. See [Limitations](#limitations) for details.

## Features

- Register and run background tasks on the server
- Real-time progress streaming to the client via SSE
- Task cancellation with AbortController/AbortSignal
- Per-task timeout with automatic cancellation (`timed_out` status)
- Reactive Svelte 5 client (`TaskEventSource`) with auto-reconnect and event replay
- Composable `TaskItem` component with snippet-based per-status rendering
- Authorization support for SSE endpoints
- Configurable task history retention (`maxHistory`)

## Install

```bash
npm install sveltekit-tasks
pnpm add sveltekit-tasks
bun add sveltekit-tasks
deno add npm:sveltekit-tasks
```

Peer dependencies: `svelte ^5.0.0`, `@sveltejs/kit ^2.0.0`

## Quick Start

### 1. Define tasks on the server

```ts
// src/lib/server/my-tasks.ts
import { TaskManager } from "sveltekit-tasks/server";

export const tasks = new TaskManager();

tasks.register("import-data", async (ctx) => {
  for (let i = 0; i < 100; i++) {
    if (ctx.isCanceled()) return;
    ctx.progress("Processing...", i + 1, 100);
    await doWork(i);
  }
});

// Auto-cancel after 5 minutes
tasks.register("slow-sync", handler, { timeout: 300_000 });
```

### 2. Create SSE and action endpoints

```ts
// src/routes/tasks/sse/+server.ts
import { tasks } from "$lib/server/my-tasks.js";

export const GET = tasks.createSSEHandler();
```

```ts
// src/routes/tasks/start/+server.ts
import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { tasks } from "$lib/server/my-tasks.js";

export const POST: RequestHandler = async ({ request }) => {
  const { taskId } = await request.json();
  if (typeof taskId !== "string" || !taskId) error(400, "Invalid taskId");
  tasks.start(taskId);
  return json({ ok: true });
};
```

### 3. Connect from the client

```svelte
<script lang="ts">
  import { TaskEventSource, TaskItem } from "sveltekit-tasks/client";

  const taskEvents = new TaskEventSource("/tasks/sse");
  const taskList = $derived([...taskEvents.tasks.values()]);
</script>

{#each taskList as task (task.id)}
  <TaskItem {task} onstart={startTask} oncancel={cancelTask} />
{/each}
```

## API

### `TaskManager` (server)

```ts
import { TaskManager } from "sveltekit-tasks/server";
import { dev } from "$app/environment";

const tasks = new TaskManager({
  debug: dev,
  maxHistory: 100, // keep only the 100 most recent terminal tasks
  eventBufferSize: 1000, // buffer 1000 events for Last-Event-ID replay
});

tasks.register(id, handler); // Register a task
tasks.register(id, handler, { timeout: 60_000 }); // Register with 60s timeout
tasks.start(taskId); // Start a task (fire-and-forget)
tasks.cancel(taskId); // Cancel a running task
tasks.getState(taskId); // Get single task state
tasks.getAllStates(); // Get all task states
tasks.subscribe(callback); // Subscribe to updates (returns unsubscribe fn)
```

The `handler` receives a `TaskContext`:

- `ctx.progress(message, current?, total?)` — report progress
- `ctx.isCanceled()` — check if task was canceled
- `ctx.signal` — `AbortSignal` for passing to `fetch()`, etc.

> **Note:** `start()` and `cancel()` are silent no-ops when the task id is unknown or the task is already running/not running respectively. Enable `debug: true` to log these cases to the console during development.

> **Cancellation is cooperative.** Calling `cancel()` aborts the `AbortSignal` and transitions the task to `"canceled"` status, but the handler continues running until it checks `ctx.isCanceled()` or its `ctx.signal` is observed. If you call `cancel()` then immediately `start()`, two handler instances run concurrently for a brief period — the library's generation counter prevents the old run from clobbering state, but the old handler still performs work until it cooperatively exits.

#### `maxHistory`

Limits the number of tasks in terminal states (completed, error, canceled, timed_out) kept in memory. When exceeded, the oldest terminal tasks (by `lastRun`) are evicted from all internal maps. Useful for long-running servers with dynamically registered tasks.

#### `eventBufferSize`

Enables event buffering for `Last-Event-ID` replay. When a client reconnects, it sends its last received event ID. If the buffer can satisfy the request, only missed events are replayed instead of a full state dump. Set to `0` (default) to disable.

### `tasks.createSSEHandler(options?)`

```ts
export const GET = tasks.createSSEHandler({
  authorize: (event) => event.locals.user?.isAdmin, // optional auth check
  heartbeatInterval: 30_000, // keepalive interval (ms)
});
```

### `TaskEventSource` (client)

```ts
import { TaskEventSource } from "sveltekit-tasks/client";

const taskEvents = new TaskEventSource("/sse-url", {
  reconnectDelay: 1000, // initial reconnect delay (ms), default 1000
  maxReconnectDelay: 30_000, // max backoff delay (ms), default 30000
  maxRetries: 10, // max reconnect attempts, default 10
  onError: (event) => {}, // error callback
});
```

- `taskEvents.tasks` — reactive `SvelteMap<string, TaskState>`, updated in real-time from SSE messages
- `taskEvents.connected` — reactive `boolean`, `true` while the SSE connection is open

Reconnects with exponential backoff on disconnect, sending the last event ID for replay when available.

### `TaskItem` (client)

Renders task UI based on status. Per-status snippets receive **narrowed** types — e.g. the `completed` snippet receives `{ id, status: "completed", lastRun }` so `task.lastRun` is directly accessible without type narrowing:

```svelte
<TaskItem {task} onstart={handleStart} oncancel={handleCancel}>
  {#snippet running(task)}
    <p>{task.progress?.message}</p>
  {/snippet}
  {#snippet completed(task)}
    <p>Done at {new Date(task.lastRun).toLocaleTimeString()}</p>
  {/snippet}
  {#snippet error(task)}
    <p>Failed: {task.error}</p>
  {/snippet}
  {#snippet canceled(task)}...{/snippet}
  {#snippet timed_out(task)}...{/snippet}
  {#snippet pending(task)}...{/snippet}
</TaskItem>
```

Falls back to a default UI with Start/Cancel/Retry buttons when snippets are not provided.

## Types

`TaskState` is a discriminated union on `status` — narrow via `task.status === "running"` etc. to access status-specific fields:

```ts
import type {
  TaskStatus, // "pending" | "running" | "completed" | "error" | "canceled" | "timed_out"
  TaskProgress, // { message, current?, total? }
  TaskState, // discriminated union (see below)
  TaskContext, // { progress(), isCanceled(), signal }
} from "sveltekit-tasks";
```

| Status        | Fields                   |
| ------------- | ------------------------ |
| `"pending"`   | `id`                     |
| `"running"`   | `id`, `progress?`        |
| `"completed"` | `id`, `lastRun`          |
| `"error"`     | `id`, `lastRun`, `error` |
| `"canceled"`  | `id`, `lastRun`          |
| `"timed_out"` | `id`, `lastRun`          |

## Limitations

- **In-memory only** — task state is not persisted. A server restart loses all state and running tasks.
- **Single-instance** — state is held in a JS `Map`. In multi-process or multi-server deployments, tasks on one instance are not visible to SSE connections on another.
- **No concurrency control** — all registered tasks can run simultaneously. Implement your own limiter if needed.
- **No progress throttling** — every `ctx.progress()` call emits an SSE message. If your task reports progress in a tight loop, consider adding your own debounce/throttle to avoid flooding clients.

## Future Additions

These are not currently planned but could be added in the future:

- **Persistence adapter** — pluggable storage (Redis, database) so task state survives server restarts.
- **Horizontal scaling** — shared state across multiple server instances via an adapter.
- **Concurrency control** — `maxConcurrent` option to limit how many tasks run simultaneously, with a queue for excess.
- **Task scheduling / queuing** — delayed execution, priority queues, cron-like scheduling.

## License

MIT
