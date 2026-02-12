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

- **SvelteKit 2** with **Svelte 5** (runes mode) — library project via `@sveltejs/package`
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

Experimental features enabled in `svelte.config.js`:

- `compilerOptions.runes: true` — Svelte 5 runes mode
- `compilerOptions.experimental.async: true` — `await` directly in components
- `kit.experimental.remoteFunctions: true` — remote functions (`query`/`command` from `$app/server`)

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

`$lib/server/` is a server-only boundary enforced by SvelteKit — client-reachable modules cannot import runtime values from it. Types can cross via `import type`. Place shared constants/types in `$lib/`.

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

- Don't mark functions `async` unless they actually `await` something — misleading return types cause callers to `await` a void
- In `$effect()`, separate reactive triggers (`$state`) from non-reactive counters when resetting the counter would unintentionally re-run the effect

## Design Decisions

- **SSE format**: data-only messages (`data: {...}\n\n`) with a `type` discriminator in the JSON payload. No `event:` field — avoids redundant dispatching across protocol and application layers.
- **Package exports**: the `"svelte"` condition is only needed on exports containing Svelte components or `.svelte.ts` rune files. Type-only exports (root `.`) and pure TS server code (`./server`) use `"default"` only.
- **Task run generation counter**: `TaskManager` tracks a `runGeneration` per task to prevent stale runs from clobbering state. When a task is canceled and restarted, the old `runTask` promise may still settle — the generation check ensures only the current run can update state, report progress, or clean up the abort controller.
- **`TaskEventSource` class**: uses a class (not a function) so consumers get reactive properties via `taskEvents.tasks` and `taskEvents.connected` without needing a `$derived` wrapper. This is the idiomatic Svelte 5 pattern (matches Runed, official tutorials).
- **No task return values**: `TaskHandler` returns `Promise<void>` by design. Tasks are fire-and-forget side effects — results should be written to a database/file/etc. by the handler itself, not surfaced through the task system.
- **No progress throttling**: every `ctx.progress()` emits an SSE message. Throttling/debouncing is the caller's responsibility — the library intentionally stays out of it.
- **`start()` returns `void`**: invalid task ids and already-running tasks are silent no-ops (logged when `debug: true`). No return value or thrown error — callers should use `debug` mode during development.
- **No `"./types"` package export**: the root export (`"."`) already re-exports all shared types. A separate `"./types"` entry was removed as redundant.
- **`TaskState` discriminated union**: `TaskState` is a union discriminated on `status`. Status-specific fields (`progress`, `error`, `lastRun`) only exist on their respective variants, making impossible states unrepresentable. `TaskItem` snippet props use `Extract<TaskState, { status: "..." }>` so consumers get narrowed types automatically.
- **`timed_out` as separate status**: timeouts get their own `"timed_out"` status rather than reusing `"canceled"`, so callers can distinguish manual cancellation from automatic timeout in their UI.
- **`maxHistory` eviction**: evicts the oldest terminal tasks by `lastRun` timestamp. Eviction removes from all internal maps (tasks, state, abortControllers, runGeneration, timeouts). Running and pending tasks are never evicted.
- **Event buffer on TaskManager**: the Last-Event-ID replay buffer lives on `TaskManager` (not in the SSE handler closure) so multiple SSE handler instances for the same manager share the buffer. `eventId` is always assigned to `TaskUpdateEvent` (cheap monotonic counter); buffering is only active when `eventBufferSize > 0`. Implemented as a ring buffer (O(1) writes) to avoid degradation at large buffer sizes.
- **SSE Last-Event-ID**: the server reads from the `Last-Event-ID` request header (per the SSE spec) with a `lastEventId` query parameter fallback. The built-in client hook uses the query param because `EventSource` doesn't allow setting custom headers on reconnect.
- **`register()` throws on duplicate id**: duplicate registration is a programmer error and always throws, regardless of the `debug` flag. This prevents silent handler replacement that could leave orphaned abort controllers.
- **`TaskManager` implements `Disposable`**: `[Symbol.dispose]()` clears subscribers first (so no events fire), then aborts all controllers, clears timeouts, and wipes all internal maps. Supports `using tasks = new TaskManager()`.
- **`createSSEHandler` as a method on `TaskManager`**: the SSE handler is a method (not a standalone factory function) so that `getCurrentEventId` and `getEventsSince` can be truly `private` instead of leaked as public API. The SvelteKit `RequestEvent` dependency is acceptable — this is a SvelteKit-first library.
- **`TaskSSEMessage` not exported**: the SSE wire format type is internal to `shared/types.ts`, consumed by the SSE handler and client `TaskEventSource`. Consumers don't need it unless building a custom client.
- **No concurrency control**: explicitly out of scope — callers should implement their own limiter if needed.
