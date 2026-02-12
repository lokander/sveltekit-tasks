import { SvelteMap } from "svelte/reactivity";
import type { TaskSSEMessage, TaskState } from "../shared/types.js";

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
  #connected = $state(false);
  #attempts = 0;
  #reconnectTrigger = $state(0);
  // Non-reactive — tracks the last SSE event ID for replay on reconnect
  #lastEventId = "";

  /** `true` while the SSE connection is open. */
  get connected(): boolean {
    return this.#connected;
  }

  constructor(url: string, options: TaskEventSourceOptions = {}) {
    const { reconnectDelay = 1000, maxReconnectDelay = 30_000, maxRetries = 10, onError } = options;

    $effect(() => {
      // Track reconnectTrigger to re-run on scheduled reconnect
      void this.#reconnectTrigger;

      if (this.#attempts > maxRetries) return;

      const connectUrl =
        this.#lastEventId !== ""
          ? `${url}${url.includes("?") ? "&" : "?"}lastEventId=${this.#lastEventId}`
          : url;
      const eventSource = new EventSource(connectUrl);

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
        } else if (msg.type === "update" && msg.taskId && msg.state) {
          this.tasks.set(msg.taskId, msg.state);
        }
      };

      eventSource.onerror = (event) => {
        this.#connected = false;
        onError?.(event);
        eventSource.close();

        if (this.#attempts < maxRetries) {
          const delay = Math.min(reconnectDelay * 2 ** this.#attempts, maxReconnectDelay);
          setTimeout(() => {
            this.#attempts++;
            this.#reconnectTrigger++;
          }, delay);
        }
      };

      eventSource.onopen = () => {
        this.#connected = true;
        this.#attempts = 0;
      };

      return () => {
        this.#connected = false;
        eventSource.close();
      };
    });
  }
}
