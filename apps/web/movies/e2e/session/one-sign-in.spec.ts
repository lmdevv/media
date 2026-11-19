import { refuseIdentityOnce } from "./identity";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
} from "../stack/people";

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

test("movies greets a person by the name they go by, and by their username once they clear it", async ({
  page,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "aiko", "member");
  const client = await signInClient(stack, person);

  try {
    await signIn(page, person);
    await page.goto(moviesPath());
    await expectMoviesHome(page, person.username);

    await client.platform.core.accounts.me.setDisplayName({ displayName: "Aiko Tanaka" });
    await expectMoviesHome(page, "Aiko Tanaka");

    await client.platform.core.accounts.me.setDisplayName({ displayName: null });
    await expectMoviesHome(page, person.username);
  } finally {
    await client.platform.dispose();
  }
});

for (const path of ["/movies/", "/movies/guest"]) {
  test(`a member recovers a refused identity at ${path}`, async ({ page }) => {
    if (stack === null) return;
    const person = await createPerson(stack, "identity-retry", "member");
    await signIn(page, person);
    const refusals = await refuseIdentityOnce(page);
    await page.goto(path);
    await expect.poll(refusals).toBe(1);
    await expectMoviesHome(page, person.username);
    await expect(page.getByRole("heading", { name: "Can't reach the server" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "This link isn't available" })).toHaveCount(0);
  });
}

test("a member retries a failed Music identity without reloading or losing their sign-in", async ({
  page,
}) => {
  if (stack === null) return;
  const person = await createPerson(stack, "music-identity-retry", "member");
  await signIn(page, person);
  const refusals = await refuseIdentityOnce(page, "internal");
  await page.goto("/music/");
  await expect.poll(refusals).toBe(1);
  await expect(page.getByRole("heading", { name: "Can't reach the server" })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Can't reach the server" })).toHaveCount(0);
  await page.goto("/home");
  await expect(
    page.getByRole("heading", { name: `Hi, ${person.username}.`, exact: true }),
  ).toBeVisible();
});
