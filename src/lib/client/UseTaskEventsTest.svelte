<script lang="ts">
  import { TaskEventSource } from "./use-task-events.svelte.js";
  import type { TaskEventSourceOptions } from "./use-task-events.svelte.js";

  let { url, options = {} }: { url: string; options?: TaskEventSourceOptions } = $props();
  // svelte-ignore state_referenced_locally
  const taskEvents = new TaskEventSource(url, options);
  const taskList = $derived([...taskEvents.tasks.values()]);
</script>

<div data-testid="connected">{taskEvents.connected}</div>
<div data-testid="task-count">{taskList.length}</div>
{#each taskList as task (task.id)}
  <div data-testid="task-{task.id}">{task.id}:{task.status}</div>
{/each}
