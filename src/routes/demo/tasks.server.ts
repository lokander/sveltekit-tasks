import { TaskManager } from "$lib/server/manager.js";

export const tasks = new TaskManager();

// Demo task: simulates a data import with progress
tasks.register("import-data", async (ctx) => {
  const total = 100;
  for (let i = 0; i < total; i++) {
    if (ctx.isCanceled()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctx.progress("Processing items...", i + 1, total);
  }
});

// Demo task: simulates a quick sync
tasks.register("sync-users", async (ctx) => {
  const steps = ["Fetching users...", "Validating data...", "Updating records...", "Finalizing..."];
  for (let i = 0; i < steps.length; i++) {
    if (ctx.isCanceled()) return;
    ctx.progress(steps[i], i + 1, steps.length);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});

// Demo task: always fails (for testing error state)
tasks.register("failing-task", async (ctx) => {
  ctx.progress("About to fail...");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  throw new Error("Something went wrong!");
});
