import { expect, test } from "@playwright/test";

test("home page has expected h1", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
});

test.describe("demo", () => {
  test("lists tasks once the SSE connection is open", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByText("Import Data")).toBeVisible();
    await expect(page.getByText("Sync Users")).toBeVisible();
    await expect(page.getByText("Failing Task")).toBeVisible();
  });

  test("starts a task, streams progress and cancels it", async ({ page }) => {
    await page.goto("/demo");
    const card = page.locator(".card", { hasText: "Import Data" });

    await card.getByRole("button", { name: "Start" }).click();

    await expect(card.locator(".badge")).toHaveText("running");
    await expect(card.getByText("Processing items...")).toBeVisible();
    await expect(card.locator("progress")).toBeVisible();

    await card.getByRole("button", { name: "Cancel" }).click();

    await expect(card.locator(".badge")).toHaveText("canceled");
    await expect(card.getByText("Canceled", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("shows the error message when a task fails", async ({ page }) => {
    await page.goto("/demo");
    const card = page.locator(".card", { hasText: "Failing Task" });

    await card.getByRole("button", { name: "Start" }).click();

    await expect(card.locator(".badge")).toHaveText("error", { timeout: 10_000 });
    await expect(card.getByText("Error: Something went wrong!")).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
