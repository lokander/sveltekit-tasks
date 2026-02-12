import { command } from "$app/server";
import { tasks } from "./tasks.server.js";
import * as v from "valibot";

export const startTask = command(v.string(), (taskId: string) => {
  tasks.start(taskId);
});

export const cancelTask = command(v.string(), (taskId: string) => {
  tasks.cancel(taskId);
});
