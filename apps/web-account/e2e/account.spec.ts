import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createPerson, openPlatform, signIn } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

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

const fillIn = async (tab: Page, person: Person): Promise<void> => {
  await tab.goto("/");
  await tab.getByLabel("Username").fill(person.username);
  await tab.getByLabel("Password", { exact: true }).fill(person.password);
};

test("two people signing in at once on a new browser both join its picker", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");
  const other = await context.newPage();

  await Promise.all([fillIn(page, first), fillIn(other, second)]);
  await Promise.all([
    page.getByRole("button", { name: "Sign in" }).click(),
    other.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await Promise.all(
    [page, other].flatMap((tab) =>
      [first, second].map((person) =>
        expect(tab.getByRole("button", { name: person.username, exact: true })).toBeVisible(),
      ),
    ),
  );

  await page.reload();
  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: second.username, exact: true })).toBeVisible();
});

test("two tabs share one sign-in, and a sign-out in one signs the other out", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");
  const other = await context.newPage();

  await signIn(page, person);
  await page.getByRole("button", { name: person.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);

  await other.goto("/home");
  await expect(other.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(other.getByRole("button", { name: "Sign out" })).toBeHidden();

  await other.reload();
  await expect(other.getByLabel("Username")).toBeVisible();
  expect(await other.evaluate(() => Object.keys(localStorage))).toStrictEqual([]);
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
