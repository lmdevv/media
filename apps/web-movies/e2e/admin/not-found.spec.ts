import { expect, test } from "@playwright/test";

import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
} from "../stack/people";
import type { Person } from "../stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let admin: Person | undefined;

let otherTableId = "";

test.beforeAll(async () => {
  if (stack === null) return;

  admin = await createPerson(stack, "admin");

  const client = await signInClient(stack, admin);

  try {
    otherTableId = (await client.platform.core.auth.sessions.current()).userId;
  } finally {
    await client.platform.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  if (admin === undefined) throw new Error("The admin was not made");

  await signIn(page, admin);
});

test("an unknown address inside the app keeps the shell", async ({ page }) => {
  await page.goto(moviesPath("/settings/nowhere"));

  await expect(page.getByRole("heading", { name: "This page isn't here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "[movies] home" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /: switch person$/u })).toBeVisible();

  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/movies\/$/u);
});

test("a mistyped title link says the title isn't here", async ({ page }) => {
  await page.goto(moviesPath("/title/not-a-title"));

  await expect(page.getByRole("heading", { name: "This title isn't here" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
});

test("a title link with another table's ID says the title isn't here", async ({ page }) => {
  await page.goto(moviesPath(`/title/${otherTableId}`));

  await expect(page.getByRole("heading", { name: "This title isn't here" })).toBeVisible();
});

test("a library link with a bad ID says the library is gone", async ({ page }) => {
  await page.goto(moviesPath(`/admin/libraries/${otherTableId}`));

  await expect(page.getByRole("heading", { name: "This library is gone" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Libraries" })).toBeVisible();
});

test("a crashed screen shows an admin the error", async ({ page }) => {
  await page.goto(moviesPath("/dev/crash"));

  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await page.getByText("Error details").click();
  await expect(page.getByText("This screen crashed on purpose")).toBeVisible();
});
