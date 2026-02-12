<script lang="ts" module>
  import type { Snippet } from "svelte";
  import type { TaskState } from "../shared/types.js";

  /**
   * Props for the {@link TaskItem} component.
   *
   * Provide per-status snippets to customize rendering, or use `children` as a
   * catch-all fallback. When no snippet matches, a default text + button UI is rendered.
   *
   * Per-status snippets receive a **narrowed** `TaskState` — e.g. the `completed` snippet
   * receives `{ id, status: "completed", lastRun }` so `task.lastRun` is directly accessible.
   */
  export type TaskItemProps = {
    /** The task state to render. */
    task: TaskState;
    /** Called with the task id when the user clicks Start or Retry. */
    onstart?: (id: string) => void;
    /** Called with the task id when the user clicks Cancel. */
    oncancel?: (id: string) => void;
    /** Custom rendering for `"pending"` status. */
    pending?: Snippet<[Extract<TaskState, { status: "pending" }>]>;
    /** Custom rendering for `"running"` status. */
    running?: Snippet<[Extract<TaskState, { status: "running" }>]>;
    /** Custom rendering for `"completed"` status. */
    completed?: Snippet<[Extract<TaskState, { status: "completed" }>]>;
    /** Custom rendering for `"error"` status. */
    error?: Snippet<[Extract<TaskState, { status: "error" }>]>;
    /** Custom rendering for `"canceled"` status. */
    canceled?: Snippet<[Extract<TaskState, { status: "canceled" }>]>;
    /** Custom rendering for `"timed_out"` status. */
    timed_out?: Snippet<[Extract<TaskState, { status: "timed_out" }>]>;
    /** Fallback snippet used for any status that doesn't have a dedicated snippet. */
    children?: Snippet<[TaskState]>;
  };
</script>

<script lang="ts">
  let {
    task,
    onstart,
    oncancel,
    pending,
    running,
    completed,
    error,
    canceled,
    timed_out,
    children,
  }: TaskItemProps = $props();

  function handleStart() {
    onstart?.(task.id);
  }

  function handleCancel() {
    oncancel?.(task.id);
  }
</script>

{#if task.status === "running"}
  {#if running}
    {@render running(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: running{task.progress ? ` — ${task.progress.message}` : ""}</span>
    {#if oncancel}<button onclick={handleCancel}>Cancel</button>{/if}
  {/if}
{:else if task.status === "completed"}
  {#if completed}
    {@render completed(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: completed</span>
    {#if onstart}<button onclick={handleStart}>Start</button>{/if}
  {/if}
{:else if task.status === "error"}
  {#if error}
    {@render error(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: error — {task.error}</span>
    {#if onstart}<button onclick={handleStart}>Retry</button>{/if}
  {/if}
{:else if task.status === "canceled"}
  {#if canceled}
    {@render canceled(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: canceled</span>
    {#if onstart}<button onclick={handleStart}>Start</button>{/if}
  {/if}
{:else if task.status === "timed_out"}
  {#if timed_out}
    {@render timed_out(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: timed out</span>
    {#if onstart}<button onclick={handleStart}>Retry</button>{/if}
  {/if}
{:else if task.status === "pending"}
  {#if pending}
    {@render pending(task)}
  {:else if children}
    {@render children(task)}
  {:else}
    <span>{task.id}: pending</span>
    {#if onstart}<button onclick={handleStart}>Start</button>{/if}
  {/if}
{/if}
