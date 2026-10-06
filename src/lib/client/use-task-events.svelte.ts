import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { TaskSSEMessage, TaskState } from "../shared/types.js";

/**
 * Connection status of a {@link TaskEventSource}.
 *
 * - `"connecting"` — first attempt (fresh page load) or right after {@link TaskEventSource.reconnect}.
 * - `"open"` — the SSE connection is live.
 * - `"reconnecting"` — the connection dropped; a retry is scheduled or in flight.
 * - `"exhausted"` — `maxRetries` consecutive attempts failed; call `reconnect()` to try again.
 * - `"closed"` — `close()` was called.
 */
export type TaskEventSourceStatus = "connecting" | "open" | "reconnecting" | "exhausted" | "closed";

/** Options for {@link TaskEventSource}. */
export type TaskEventSourceOptions = {
  /** Initial delay in ms before the first reconnect attempt. Doubled on each subsequent attempt. @default 1000 */
  reconnectDelay?: number;
  /** Maximum delay in ms between reconnect attempts (caps the exponential backoff). @default 30_000 */
  maxReconnectDelay?: number;
  /** Maximum number of consecutive reconnect attempts before giving up. @default 10 */
  maxRetries?: number;
  /** Called whenever the `EventSource` fires an error event (before reconnect scheduling). */
  onError?: (event: Event) => void;
};

/**
 * Reactive Svelte 5 class that connects to a task SSE endpoint and maintains
 * a live `SvelteMap` of task states. Automatically reconnects with exponential
 * backoff on disconnect.
 *
 * On reconnect, sends the last received event ID as a `lastEventId` query
 * parameter so the server can replay missed events instead of a full init dump
 * (requires `eventBufferSize > 0` on the `TaskManager`).
 *
 * Must be instantiated during component initialization (inside `<script>`).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { TaskEventSource } from "sveltekit-tasks/client";
 *   const taskEvents = new TaskEventSource("/tasks/sse");
 * </script>
 *
 * {#each [...taskEvents.tasks.values()] as task (task.id)}
 *   <p>{task.id}: {task.status}</p>
 * {/each}
 * ```
 */
export class TaskEventSource {
  /** Reactive map of task id to current {@link TaskState}. Updated in real-time from SSE messages. */
  readonly tasks = new SvelteMap<string, TaskState>();
  #status = $state<TaskEventSourceStatus>("connecting");
  #attempts = 0;
  #reconnectTrigger = $state(0);
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Non-reactive — tracks the last SSE event ID for replay on reconnect
  #lastEventId = "";

  /**
   * Reactive connection status — the single source of truth for the connection UI.
   * `"connecting"` is the state on a fresh page load (and after {@link reconnect}),
   * distinct from `"reconnecting"` after a dropped connection.
   */
  get status(): TaskEventSourceStatus {
    return this.#status;
  }

  /** `true` while the SSE connection is open. Shorthand for `status === "open"`. */
  get connected(): boolean {
    return this.#status === "open";
  }

  /** `true` once `maxRetries` consecutive reconnect attempts have failed. Shorthand for `status === "exhausted"`. */
  get exhausted(): boolean {
    return this.#status === "exhausted";
  }

  /** `true` after {@link close} has been called, until {@link reconnect}. Shorthand for `status === "closed"`. */
  get closed(): boolean {
    return this.#status === "closed";
  }

  constructor(url: string, options: TaskEventSourceOptions = {}) {
    const { reconnectDelay = 1000, maxReconnectDelay = 30_000, maxRetries = 10, onError } = options;

    $effect(() => {
      // Track reconnectTrigger to re-run on scheduled reconnect. Status is read untracked —
      // every status change would otherwise tear down and reopen the connection.
      void this.#reconnectTrigger;

      if (untrack(() => this.#status) === "closed") return;

      const connectUrl =
        this.#lastEventId !== ""
          ? `${url}${url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(this.#lastEventId)}`
          : url;
      const eventSource = new EventSource(connectUrl);
      // Ids received in this connection's init dump — anything else is gone once "synced" arrives.
      // Only read in `onmessage`, never rendered, so it doesn't need to be reactive.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const dumped = new Set<string>();

      eventSource.onmessage = (event: MessageEvent) => {
        if (event.lastEventId) {
          this.#lastEventId = event.lastEventId;
        }

        let msg: TaskSSEMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn("[sveltekit-tasks] Failed to parse SSE message:", event.data);
          return;
        }
        if (msg.type === "init" && msg.task?.id) {
          this.tasks.set(msg.task.id, msg.task);
          dumped.add(msg.task.id);
        } else if (msg.type === "synced") {
          for (const id of this.tasks.keys()) {
            if (!dumped.has(id)) this.tasks.delete(id);
          }
        } else if (msg.type === "update" && msg.taskId && msg.state) {
          this.tasks.set(msg.taskId, msg.state);
        } else if (msg.type === "removed" && msg.taskId) {
          this.tasks.delete(msg.taskId);
        }
      };

      eventSource.onerror = (event) => {
        onError?.(event);
        eventSource.close();

        if (this.#attempts < maxRetries) {
          this.#status = "reconnecting";
          const delay = Math.min(reconnectDelay * 2 ** this.#attempts, maxReconnectDelay);
          this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            this.#attempts++;
            this.#reconnectTrigger++;
          }, delay);
        } else {
          this.#status = "exhausted";
        }
      };

      eventSource.onopen = () => {
        this.#status = "open";
        this.#attempts = 0;
      };

      return () => {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
        eventSource.close();
      };
    });
  }

  /**
   * Close the connection and stop reconnecting. The task map is kept as-is.
   * Call {@link reconnect} to open a new connection.
   */
  close(): void {
    this.#status = "closed";
    this.#reconnectTrigger++;
  }

  /**
   * (Re)open the connection immediately, resetting the retry counter. Use this
   * after {@link close}, or once {@link exhausted} is `true`.
   */
  reconnect(): void {
    this.#attempts = 0;
    this.#status = "connecting";
    this.#reconnectTrigger++;
  }
}
