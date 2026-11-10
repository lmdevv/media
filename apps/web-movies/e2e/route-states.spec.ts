import { expect, test } from "@playwright/test";

import { NO_STACK, createPerson, moviesPath, reachableStack, signIn } from "./stack/people";
import type { Person } from "./stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let person: Person | undefined;

test.beforeAll(async () => {
  if (stack !== null) person = await createPerson(stack, "kit", "member");
});

test.beforeEach(async ({ page }) => {
  if (person !== undefined) await signIn(page, person);
});

test("an unknown address says so and leads home", async ({ page }) => {
  await page.goto(moviesPath("/nowhere/at-all"));

  await expect(page.getByRole("heading", { name: "This page isn't here" })).toBeVisible();
  await expect(page).toHaveTitle("Not found · [movies]");
  await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/movies/");
});

test("a crashed screen recovers with Try again", async ({ page }) => {
  const now = Date.now();
  const until = now + 60_000;

  await page.clock.setFixedTime(now);
  await page.goto(moviesPath(`/dev/crash?until=${until}`));
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();

  await page.clock.setFixedTime(until);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "This screen recovered" })).toBeVisible();
});
