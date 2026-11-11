import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { NO_STACK, createPerson, moviesPath, reachableStack, signIn } from "../stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

/** The movies Home of `username`, with their account button. */
const expectMoviesHome = async (tab: Page, username: string): Promise<void> => {
  await expect(tab).toHaveURL(/\/movies\/$/u);
  await expect(tab.getByRole("button", { name: `${username}: switch person` })).toBeVisible();
  await expect(tab.getByLabel("Username")).toHaveCount(0);
};

/** The account client's sign-in form at `/`. */
const expectSignedOut = async (tab: Page): Promise<void> => {
  await expect(tab).toHaveURL(/\/$/u);
  await expect(tab.getByLabel("Username")).toBeVisible();
  await expect(tab.getByRole("button", { name: "Sign in" })).toBeVisible();
};

test("one sign-in at / opens /movies signed in in every tab, and a sign-out there signs them all out", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia", "member");

  await signIn(page, person);
  await page.goto(moviesPath());
  await expectMoviesHome(page, person.username);

  const second = await context.newPage();

  await second.goto(moviesPath());
  await expectMoviesHome(second, person.username);

  await page.bringToFront();
  await page.getByRole("button", { name: `${person.username}: switch person` }).click();
  await page.getByRole("option", { name: `Sign out ${person.username}` }).click();

  await expectSignedOut(page);
  await expectSignedOut(second);

  await second.goto(moviesPath());
  await expectSignedOut(second);
});
