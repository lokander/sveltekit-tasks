import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import TaskItem from "./TaskItem.svelte";
import type { TaskState } from "../shared/types.js";

function makeTask(
  status: TaskState["status"] = "pending",
  extra: Record<string, unknown> = {},
): TaskState {
  const id = (extra.id as string) ?? "test-task";
  switch (status) {
    case "pending":
      return { id, status };
    case "running":
      return { id, status, ...(extra.progress ? { progress: extra.progress } : {}) } as TaskState;
    case "completed":
      return { id, status, lastRun: (extra.lastRun as number) ?? Date.now() };
    case "error":
      return {
        id,
        status,
        lastRun: (extra.lastRun as number) ?? Date.now(),
        error: (extra.error as string) ?? "Unknown error",
      };
    case "canceled":
      return { id, status, lastRun: (extra.lastRun as number) ?? Date.now() };
    case "timed_out":
      return { id, status, lastRun: (extra.lastRun as number) ?? Date.now() };
  }
}

describe("TaskItem", () => {
  describe("pending status", () => {
    it("renders default pending UI", async () => {
      const screen = render(TaskItem, { task: makeTask() });
      await expect.element(screen.getByText("test-task: pending")).toBeVisible();
    });

    it("shows Start button when onstart is provided", async () => {
      const onstart = vi.fn();
      const screen = render(TaskItem, { task: makeTask(), onstart });
      await screen.getByRole("button", { name: "Start" }).click();
      expect(onstart).toHaveBeenCalledWith("test-task");
    });

    it("hides Start button when onstart is not provided", async () => {
      const screen = render(TaskItem, { task: makeTask() });
      await expect.element(screen.getByRole("button", { name: "Start" })).not.toBeInTheDocument();
    });
  });

  describe("running status", () => {
    it("renders default running UI without progress", async () => {
      const screen = render(TaskItem, { task: makeTask("running") });
      await expect.element(screen.getByText("test-task: running")).toBeVisible();
    });

    it("renders progress message", async () => {
      const task = makeTask("running", {
        progress: { message: "Processing items...", current: 5, total: 10 },
      });
      const screen = render(TaskItem, { task });
      await expect
        .element(screen.getByText("test-task: running — Processing items..."))
        .toBeVisible();
    });

    it("shows Cancel button when oncancel is provided", async () => {
      const oncancel = vi.fn();
      const screen = render(TaskItem, {
        task: makeTask("running"),
        oncancel,
      });
      await screen.getByRole("button", { name: "Cancel" }).click();
      expect(oncancel).toHaveBeenCalledWith("test-task");
    });

    it("hides Cancel button when oncancel is not provided", async () => {
      const screen = render(TaskItem, { task: makeTask("running") });
      await expect.element(screen.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    });
  });

  describe("completed status", () => {
    it("renders default completed UI", async () => {
      const screen = render(TaskItem, { task: makeTask("completed") });
      await expect.element(screen.getByText("test-task: completed")).toBeVisible();
    });

    it("shows Start button for re-run", async () => {
      const onstart = vi.fn();
      const screen = render(TaskItem, {
        task: makeTask("completed"),
        onstart,
      });
      await screen.getByRole("button", { name: "Start" }).click();
      expect(onstart).toHaveBeenCalledWith("test-task");
    });
  });

  describe("error status", () => {
    it("renders error message", async () => {
      const task = makeTask("error", { error: "Connection refused" });
      const screen = render(TaskItem, { task });
      await expect.element(screen.getByText("test-task: error — Connection refused")).toBeVisible();
    });

    it("shows Retry button when onstart is provided", async () => {
      const onstart = vi.fn();
      const screen = render(TaskItem, {
        task: makeTask("error", { error: "boom" }),
        onstart,
      });
      await screen.getByRole("button", { name: "Retry" }).click();
      expect(onstart).toHaveBeenCalledWith("test-task");
    });
  });

  describe("canceled status", () => {
    it("renders default canceled UI", async () => {
      const screen = render(TaskItem, { task: makeTask("canceled") });
      await expect.element(screen.getByText("test-task: canceled")).toBeVisible();
    });

    it("shows Start button for restart", async () => {
      const onstart = vi.fn();
      const screen = render(TaskItem, {
        task: makeTask("canceled"),
        onstart,
      });
      await screen.getByRole("button", { name: "Start" }).click();
      expect(onstart).toHaveBeenCalledWith("test-task");
    });
  });

  describe("timed_out status", () => {
    it("renders default timed out UI", async () => {
      const screen = render(TaskItem, { task: makeTask("timed_out") });
      await expect.element(screen.getByText("test-task: timed out")).toBeVisible();
    });

    it("shows Retry button when onstart is provided", async () => {
      const onstart = vi.fn();
      const screen = render(TaskItem, {
        task: makeTask("timed_out"),
        onstart,
      });
      await screen.getByRole("button", { name: "Retry" }).click();
      expect(onstart).toHaveBeenCalledWith("test-task");
    });

    it("hides Retry button when onstart is not provided", async () => {
      const screen = render(TaskItem, { task: makeTask("timed_out") });
      await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });
  });
});
