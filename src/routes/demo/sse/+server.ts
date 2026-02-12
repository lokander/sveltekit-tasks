import { tasks } from "../tasks.server.js";

export const GET = tasks.createSSEHandler();
