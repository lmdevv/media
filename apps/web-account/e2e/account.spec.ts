import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createPerson, openPlatform } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

const signIn = async (page: Page, person: Person): Promise<void> => {
  await page.goto("/");
  await page.getByLabel("Username").fill(person.username);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in" }).click();
};

test("signing in at / shows the picker with the signed-in person", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");

  await signIn(page, person);

  await expect(page.getByRole("heading", { name: "Who's here?" })).toBeVisible();
  await expect(page.getByRole("button", { name: person.username, exact: true })).toBeVisible();
});

test("a second person signed in on this browser joins the picker", async ({ page }) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");

  await signIn(page, first);
  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();

  await page.goto("/add");
  await page.getByLabel("Username").fill(second.username);
  await page.getByLabel("Password", { exact: true }).fill(second.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: second.username, exact: true })).toBeVisible();

  await page.getByRole("button", { name: first.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);
  await expect(page.getByRole("link", { name: `${first.username}, switch person` })).toBeVisible();
});

test("accepting an invite lands the new person on the picker", async ({ page }) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const platform = openPlatform(stack);

  try {
    await platform.session.signInWithPassword(admin);
    const { code } = await platform.core.accounts.invites.create({});

    const username = `sam-${Math.random().toString(36).slice(2, 8)}`;

    await page.goto(`/invite/${code}`);
    await expect(page.getByRole("heading", { name: "You're invited." })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("a long enough password");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Who's here?" })).toBeVisible();
    await expect(page.getByRole("button", { name: username, exact: true })).toBeVisible();
  } finally {
    await platform.dispose();
  }
});

test("a CLI link signs in, then approves its code on the same page", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");
  const device = openPlatform(stack);

  try {
    const pending = await device.session.startDeviceSignIn("media CLI on e2e");
    const signedIn = pending.complete();

    await page.goto(`/device?code=${pending.userCode.replace("-", "")}`);
    await page.getByLabel("Username").fill(person.username);
    await page.getByLabel("Password", { exact: true }).fill(person.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/device\?code=/u);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.getByRole("heading", { name: "media CLI on e2e is signed in." }),
    ).toBeVisible();

    await signedIn;
    expect((await device.core.auth.sessions.current()).username).toBe(person.username);
  } finally {
    await device.dispose();
  }
});
