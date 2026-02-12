<script lang="ts">
  import { TaskEventSource } from "$lib/client/use-task-events.svelte.js";
  import TaskItem from "$lib/client/TaskItem.svelte";
  import { startTask, cancelTask } from "./tasks.remote.js";

  const taskNames: Record<string, string> = {
    "import-data": "Import Data",
    "sync-users": "Sync Users",
    "failing-task": "Failing Task",
  };

  const taskEvents = new TaskEventSource("/demo/sse");
  const taskList = $derived([...taskEvents.tasks.values()]);
</script>

<div class="mx-auto max-w-2xl p-8">
  <h1 class="mb-2 text-2xl font-bold">Demo</h1>
  <p class="mb-6 text-sm text-base-content/60">Real-time task management with SSE streaming.</p>

  {#if !taskEvents.connected}
    <p class="text-base-content/40">Connecting to task manager...</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each taskList as task (task.id)}
        <div class="card-bordered card bg-base-200">
          <div class="card-body gap-3 p-4">
            <div class="flex items-center justify-between">
              <span class="card-title text-base">{taskNames[task.id] ?? task.id}</span>
              <span class="badge badge-ghost badge-sm">{task.status}</span>
            </div>

            <TaskItem {task} onstart={startTask} oncancel={cancelTask}>
              {#snippet running(runningTask)}
                <div>
                  <p class="text-sm text-info">{runningTask.progress?.message}</p>
                  {#if runningTask.progress?.total}
                    <progress
                      class="progress mt-1 w-full progress-info"
                      value={runningTask.progress.current ?? 0}
                      max={runningTask.progress.total}
                    ></progress>
                    <p class="mt-1 text-xs text-base-content/50">
                      {runningTask.progress.current}/{runningTask.progress.total} — {taskNames[
                        runningTask.id
                      ] ?? runningTask.id}
                    </p>
                  {/if}
                  <button
                    class="btn mt-2 btn-soft btn-sm btn-error"
                    onclick={() => cancelTask(runningTask.id)}
                  >
                    Cancel
                  </button>
                </div>
              {/snippet}

              {#snippet completed(completedTask)}
                <div>
                  <p class="text-sm text-success">
                    Completed at {new Date(completedTask.lastRun).toLocaleTimeString()}
                  </p>
                  <button
                    class="btn mt-2 btn-soft btn-sm btn-primary"
                    onclick={() => startTask(completedTask.id)}
                  >
                    Start
                  </button>
                </div>
              {/snippet}

              {#snippet error(errorTask)}
                <div>
                  <p class="text-sm text-error">Error: {errorTask.error}</p>
                  <button
                    class="btn mt-2 btn-soft btn-sm btn-primary"
                    onclick={() => startTask(errorTask.id)}
                  >
                    Retry
                  </button>
                </div>
              {/snippet}

              {#snippet canceled(canceledTask)}
                <div>
                  <p class="text-sm text-warning">Canceled</p>
                  <button
                    class="btn mt-2 btn-soft btn-sm btn-primary"
                    onclick={() => startTask(canceledTask.id)}
                  >
                    Start
                  </button>
                </div>
              {/snippet}

              {#snippet pending(pendingTask)}
                <div>
                  <p class="text-sm text-base-content/50">Never run</p>
                  <button
                    class="btn mt-2 btn-soft btn-sm btn-primary"
                    onclick={() => startTask(pendingTask.id)}
                  >
                    Start
                  </button>
                </div>
              {/snippet}
            </TaskItem>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
