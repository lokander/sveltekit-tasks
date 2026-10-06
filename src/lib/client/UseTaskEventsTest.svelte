<script lang="ts">
  import { TaskEventSource } from "./use-task-events.svelte.js";
  import type { TaskEventSourceOptions } from "./use-task-events.svelte.js";

  let { url, options = {} }: { url: string; options?: TaskEventSourceOptions } = $props();
  // svelte-ignore state_referenced_locally
  const taskEvents = new TaskEventSource(url, options);
  const taskList = $derived([...taskEvents.tasks.values()]);

  /** Test hook: expose the instance so tests can call `close()` / `reconnect()`. */
  export function getSource(): TaskEventSource {
    return taskEvents;
  }
</script>

<div data-testid="status">{taskEvents.status}</div>
<div data-testid="connected">{taskEvents.connected}</div>
<div data-testid="exhausted">{taskEvents.exhausted}</div>
<div data-testid="closed">{taskEvents.closed}</div>
<div data-testid="task-count">{taskList.length}</div>
{#each taskList as task (task.id)}
  <div data-testid="task-{task.id}">{task.id}:{task.status}</div>
{/each}
