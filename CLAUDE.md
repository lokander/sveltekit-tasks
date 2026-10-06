# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note to Claude:** When you research something, make a non-obvious decision, or explicitly decline a feature during a session, update the relevant section below (especially Design Decisions and Conventions) so we don't have to re-research or re-debate it later.

## Commands

```bash
bun run dev              # Start dev server
bun run build            # Production build (vite build + svelte-package + publint)
bun run preview          # Preview production build
bun run check            # TypeScript/Svelte type checking
bun run lint             # Run Prettier + ESLint checks
bun run format           # Auto-format with Prettier
bun run test             # Run all tests once (unit + e2e)
bun run test:unit        # Run unit tests in watch mode
bun run test:e2e         # Run Playwright e2e tests
```

Run a single test file or project:

```bash
bun run test:unit -- --run src/demo.spec.ts       # Single file, no watch
bun run test:unit -- --project server             # Only server tests
bun run test:unit -- --project client             # Only client (browser) tests
```

## Tech Stack

- **SvelteKit 3** with **Svelte 5** (runes mode) — library project via `@sveltejs/package`
- **Bun** as package manager
- **Tailwind CSS 4** (Vite plugin integration)
- **MDsveX** for Markdown in Svelte components (`.svx` files)
- **Vitest** for unit/component testing, **Playwright** for e2e

## Project Structure

This is a **SvelteKit library project** — `src/lib/` contains the publishable package, `src/routes/` is a demo/showcase app.

- `src/lib/index.ts` — library entry point (re-export components here)
- `src/routes/` — demo app for previewing the library
- `dist/` — built package output (from `svelte-package`)

## Svelte 5 Configuration

SvelteKit 3 no longer reads `svelte.config.js` — all Svelte/Kit options are passed to the `sveltekit()` plugin in `vite.config.ts`. Experimental features enabled there:

- `compilerOptions.runes: true` — Svelte 5 runes mode
- `compilerOptions.experimental.async: true` — `await` directly in components
- `experimental.remoteFunctions: true` — remote functions (`query`/`command` from `$app/server`)

Core runes:

- `$state()` for reactive state (`$state.raw()` for non-deeply-reactive)
- `$derived()` for computed values (`$derived.by()` for complex derivations)
- `$effect()` for side effects
- `$props()` for component props, `$bindable()` for two-way binding
- `{@render children()}` instead of `<slot/>`

### Remote Functions

Remote functions go in `.remote.ts` files in `src/lib/remotes/`. Function types from `$app/server`:

- `query` — read data (GET-like, cacheable)
- `command` — mutations (POST-like)

Both support three overloads: `fn(handler)`, `fn('unchecked', handler)`, `fn(schema, handler)`.

Usage in components:

- `let data = await remoteQuery()` — one-time call
- `let data = $derived(await remoteQuery(reactiveValue))` — re-runs reactively

### Server/Client Boundary

`src/lib/server/` is a server-only boundary enforced by SvelteKit — client-reachable modules cannot import runtime values from it. Types can cross via `import type`. Place shared constants/types in `src/lib/`. The demo app imports library code via the `#lib` subpath import (declared in `package.json` `imports`; SvelteKit 3 replaced `$lib`).

## Testing

**Vitest** with two projects in `vite.config.ts`:

- `server` — Node environment for `src/**/*.{test,spec}.ts` (excludes `.svelte.*`)
- `client` — Playwright browser environment for `src/**/*.svelte.{test,spec}.ts`

`requireAssertions: true` — every test must contain at least one assertion.

## Code Style

Prettier enforced (`bun run format` / `bun run lint`):

- Double quotes, semicolons, trailing commas (`"all"`)
- 2-space indent (no tabs), 100-char print width
- Plugins: `prettier-plugin-svelte`, `prettier-plugin-tailwindcss`
- American English spelling (e.g. `canceled`, not `cancelled`)
- Prefer `satisfies` over `as` casts for type validation

## Conventions

- Commit messages use [Conventional Commits](https://www.conventionalcommits.org/), subject line only (e.g. `fix: replay after server restart`, `feat(client): add close() and reconnect()`) — no body, no footer
- Don't mark functions `async` unless they actually `await` something — misleading return types cause callers to `await` a void
- In `$effect()`, separate reactive triggers (`$state`) from non-reactive counters when resetting the counter would unintentionally re-run the effect
- Server unit tests use `vi.useFakeTimers()` (see `manager.spec.ts`): tests advance time with `tick(ms)` (`vi.advanceTimersByTimeAsync`), task handlers simulate work with `sleep(ms)` (a plain `setTimeout` promise on the faked clock). Never call `tick` from inside a handler — it would advance the clock the test is controlling

## Design Decisions

- **SSE format**: data-only messages (`data: {...}\n\n`) with a `type` discriminator in the JSON payload. No `event:` field — avoids redundant dispatching across protocol and application layers.
- **`@sveltejs/kit` peer range is `^2.0.0 || ^3.0.0`**: the published code only imports the `RequestEvent` type from Kit, which both majors provide (Kit 3 just makes its fields `readonly`, and we only read them). Development and CI run on Kit 3. README examples keep `$lib/...` imports because they are still valid on Kit 2; Kit 3 users write `#lib/...`.
- **TypeScript is capped at 6**: Kit 3 and `@sveltejs/package` 3 require TS 6, while `svelte-check` and `typescript-eslint` don't support TS 7 yet. Revisit when their peer ranges allow it.
- **Package exports**: the `"svelte"` condition is only needed on exports containing Svelte components or `.svelte.ts` rune files. Type-only exports (root `.`) and pure TS server code (`./server`) use `"default"` only.
- **Task run generation counter**: `TaskManager` tracks a `runGeneration` per task to prevent stale runs from clobbering state. When a task is canceled and restarted, the old `runTask` promise may still settle — the generation check ensures only the current run can update state, report progress, or clean up the abort controller.
- **`TaskEventSource` class**: uses a class (not a function) so consumers get reactive properties via `taskEvents.tasks` and `taskEvents.connected` without needing a `$derived` wrapper. This is the idiomatic Svelte 5 pattern (matches Runed, official tutorials).
- **No task return values**: `TaskHandler` returns `Promise<void>` by design. Tasks are fire-and-forget side effects — results should be written to a database/file/etc. by the handler itself, not surfaced through the task system.
- **No progress throttling**: every `ctx.progress()` emits an SSE message. Throttling/debouncing is the caller's responsibility — the library intentionally stays out of it.
- **`start()` returns `void`**: invalid task ids and already-running tasks are silent no-ops (logged when `debug: true`). No return value or thrown error — callers should use `debug` mode during development.
- **No `"./types"` package export**: the root export (`"."`) already re-exports all shared types. A separate `"./types"` entry was removed as redundant.
- **`TaskState` discriminated union**: `TaskState` is a union discriminated on `status`. Status-specific fields (`progress`, `error`, `lastRun`) only exist on their respective variants, making impossible states unrepresentable. `TaskItem` snippet props use `Extract<TaskState, { status: "..." }>` so consumers get narrowed types automatically.
- **`timed_out` as separate status**: timeouts get their own `"timed_out"` status rather than reusing `"canceled"`, so callers can distinguish manual cancellation from automatic timeout in their UI.
- **`maxHistory` eviction**: evicts the oldest terminal tasks by `lastRun` timestamp. Running and pending tasks are never evicted. A registered task is **reset to `"pending"`** (handler kept, `"update"` event emitted) — removing it outright silently made statically registered tasks unstartable once the history filled up. Only tasks registered with `ephemeral: true` (dynamic per-job ids) and persisted states for unregistered ids are removed from all internal maps, emitting a `"removed"` event for ids clients had seen.
- **`register()` emits an event**: registration goes through the same `emit()` path as state changes (an `"update"` carrying the `"pending"` state), so connected SSE clients and replay buffers learn about dynamically registered tasks. Previously `register()` wrote to the state map silently and clients only saw the task once it was started.
- **`"removed"` SSE message / `TaskRemovedEvent`**: `subscribe()` receives `TaskEvent = TaskUpdateEvent | TaskRemovedEvent`, discriminated on `type`. The client deletes the task from its `SvelteMap` on `"removed"`. Adding a `type` field to `TaskUpdateEvent` is additive; subscribers that read `event.state` now have to narrow on `event.type`.
- **Event buffer on TaskManager**: the Last-Event-ID replay buffer lives on `TaskManager` (not in the SSE handler closure) so multiple SSE handler instances for the same manager share the buffer. `eventId` is always assigned to every `TaskEvent` (cheap monotonic counter); buffering is only active when `eventBufferSize > 0`. Implemented as a ring buffer (O(1) writes) to avoid degradation at large buffer sizes.
- **SSE Last-Event-ID**: the server reads from the `Last-Event-ID` request header (per the SSE spec) with a `lastEventId` query parameter fallback. The built-in client hook uses the query param because `EventSource` doesn't allow setting custom headers on reconnect.
- **Epoch-tagged SSE ids**: wire ids are `<epoch>:<eventId>` where `epoch` is a random per-`TaskManager` string. Event counters restart at 1 in every process, so a numeric-only id from before a server restart used to pass the gap check, replay nothing, and skip the init dump — leaving the client stale forever. Any id with a foreign or missing epoch, a non-integer counter, or a counter above the current one falls back to the full init dump. The client treats the id as an opaque string and URL-encodes it.
- **SSE stream opens with a `: connected` comment**: Node's `http` server (adapter-node, Vite dev/preview, Bun's `node:http`) only sends response headers with the first body chunk, and `EventSource` doesn't fire `open` until it sees them. With no registered tasks, or a replay with no missed events, nothing else is enqueued, so clients sat in `"connecting"` until the first heartbeat (~30 s). Native `Bun.serve` flushes headers immediately and was never affected. A `retry:` field was declined: the built-in client closes the `EventSource` on error and runs its own backoff, so it would never use it, and the server doesn't know the client's `reconnectDelay`.
- **SSE streams are tracked for dispose**: each open stream registers a cleanup (clear heartbeat, unsubscribe, `controller.close()`) in a private `streams` set so `[Symbol.dispose]()` actually ends open responses instead of leaving heartbeats running until the client disconnects. The response also sets `X-Accel-Buffering: no` so nginx streams events without extra config.
- **`TaskEventSource.status` is the single source of truth**: one `$state` union (`"connecting" | "open" | "reconnecting" | "exhausted" | "closed"`); `connected`, `exhausted` and `closed` are derived boolean shorthands kept for convenience. A user reported that `connected === false` on a fresh page load rendered as "reconnecting…" — `"connecting"` (first attempt / after `reconnect()`) is deliberately distinct from `"reconnecting"` (after a drop) so UIs don't show an error state before the first `open`. `connected` was not changed to `boolean | undefined`: that would force every existing consumer to handle a tri-state when `status` carries richer information anyway.
- **The connection effect tracks only `#reconnectTrigger`**: `#status` is read with `untrack()` inside the effect, otherwise every status change (including `onopen` setting `"open"`) would tear down and reopen the connection. `close()` sets `"closed"` and bumps the trigger so the teardown runs and the effect returns early; `reconnect()` sets `"connecting"`, resets the retry counter and bumps the trigger. A successful `onopen` resets the counter, so retries count consecutive failures, not lifetime failures. The reconnect timer is cleared on teardown so an unmounted component never reconnects.
- **`register()` throws on duplicate id**: duplicate registration is a programmer error and always throws, regardless of the `debug` flag. This prevents silent handler replacement that could leave orphaned abort controllers.
- **`TaskManager` implements `Disposable`**: `[Symbol.dispose]()` clears subscribers first (so no events fire), then aborts all controllers, clears timeouts, and wipes all internal maps. Supports `using tasks = new TaskManager()`.
- **`createSSEHandler` as a method on `TaskManager`**: the SSE handler is a method (not a standalone factory function) so that `getCurrentEventId` and `getEventsSince` can be truly `private` instead of leaked as public API. The SvelteKit `RequestEvent` dependency is acceptable — this is a SvelteKit-first library.
- **`TaskSSEMessage` not exported**: the SSE wire format type is internal to `shared/types.ts`, consumed by the SSE handler and client `TaskEventSource`. Consumers don't need it unless building a custom client.
- **No concurrency control**: explicitly out of scope — callers should implement their own limiter if needed.
- **Persistence adapter**: opt-in via `persistence` option; in-memory by default. The in-memory `Map` stays the source of truth and the adapter is write-through (`load` once on construction, `save`/`delete` after). This keeps `getState`/`register`/`start` synchronous while allowing async adapters (`MaybePromise` return types). Async writes are serialized via a promise chain; failures are logged, never thrown. Sync adapters (SQLite) hydrate in the constructor with no race.
- **Only status transitions are persisted**: progress is transient — after a restart a running task is either marked `"error"` (`INTERRUPTED_ERROR`) or restarted from scratch (`restartInterrupted: true` register option), so persisted progress would be meaningless and costly for remote stores.
- **Hydration on register**: persisted state for unregistered ids is held in a private `persisted` map and applied when the id is registered. It is never exposed via `getAllStates()` (no handler = not a task), but it does count toward `maxHistory` so dynamic ids don't accumulate forever. With an async `load()`, tasks already started in this process (tracked by `runGeneration`) are not overwritten.
- **`sqliteAdapter` is zero-dependency**: it takes a structural `SqliteDatabase` type (`exec` + `prepare().run()/.all()`) satisfied by `node:sqlite`, `better-sqlite3` and `bun:sqlite`, so no driver is bundled or required. Uses explicit columns (not a JSON blob) so the table is inspectable. Exported from `./server`; future adapters with runtime deps (Postgres, Redis) should get their own subpath export.
- **No `engines` field**: `node:sqlite` (Node 22.5+) is only needed by `persistence.spec.ts`, not by the published library, so the requirement is enforced in CI (`.github/workflows/ci.yml` pins Node 22) and mentioned in the README rather than blocking consumers on older Node.
- **Demo app stays in-memory**: the demo in `src/routes/demo/` does not use `sqliteAdapter`, so it creates no `.db` file and doesn't depend on a Node version that has `node:sqlite`. Persistence is covered by `persistence.spec.ts`.
