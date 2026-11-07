import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createPerson, newSecret, openPlatform, signIn } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

/** Opens a link that carries a secret. A failed navigation names the URL, so its error is replaced. */
const open = async (page: Page, link: string): Promise<void> => {
  try {
    await page.goto(link);
  } catch {
    throw new Error("Opening the link failed");
  }
};

test("accepting an invite lands the new person on the picker", async ({ page }) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const platform = openPlatform(stack);

  try {
    await platform.session.signInWithPassword(admin);
    const { code } = await platform.core.accounts.invites.create({});

    const username = `sam-${Math.random().toString(36).slice(2, 8)}`;

    await open(page, `/invite#${code}`);
    await expect(page.getByRole("heading", { name: "You're invited." })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(newSecret());
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Who's here?" })).toBeVisible();
    await expect(page.getByRole("button", { name: username, exact: true })).toBeVisible();
  } finally {
    await platform.dispose();
  }
});

const watchRequests = (page: Page): ReadonlyArray<string> => {
  const seen: Array<string> = [];

  page.on("request", (request) => {
    seen.push(request.url(), request.headers()["referer"] ?? "");
  });

  return seen;
};

test("an invite link keeps its code out of requests, referrers, the address, and history", async ({
  page,
  browser,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");

  await signIn(page, admin);
  await page.getByRole("button", { name: admin.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Create invite link" }).click();

  const link = (await page.getByLabel("Invite link").textContent()) ?? "";
  const code = link.split(/[/#]/u).at(-1) ?? "";

  expect(code.startsWith("mi_"), "the admin page shows an invite link").toBe(true);

  const invitee = await browser.newPage();
  const requests = watchRequests(invitee);
  const username = `sam-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await open(invitee, link);
    await expect(invitee.getByRole("heading", { name: "You're invited." })).toBeVisible();
    expect(invitee.url().includes(code), "the address holds the code after opening").toBe(false);

    await invitee.getByLabel("Username").fill(username);
    await invitee.getByLabel("Password", { exact: true }).fill(newSecret());
    await invitee.getByRole("button", { name: "Create account" }).click();
    await expect(invitee.getByRole("button", { name: username, exact: true })).toBeVisible();

    await invitee.goBack();
    expect(invitee.url().includes(code), "history holds the code").toBe(false);
    expect(
      requests.filter((sent) => sent.includes(code)).length,
      "requests carrying the code",
    ).toBe(0);
  } finally {
    await invitee.close();
  }
});

test("a reset link keeps its code out of requests, referrers, the address, and history", async ({
  page,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const person = await createPerson(stack, "aiko");
  const platform = openPlatform(stack);
  const own = openPlatform(stack);
  const requests = watchRequests(page);

  try {
    await own.session.signInWithPassword(person);
    const { userId } = await own.core.auth.sessions.current();

    await platform.session.signInWithPassword(admin);
    const { code } = await platform.core.accounts.resetLinks.create({ userId });

    await open(page, `/reset#${code}`);
    await expect(page.getByRole("heading", { name: "Set a new password." })).toBeVisible();
    expect(page.url().includes(code), "the address holds the code after opening").toBe(false);

    await page.getByLabel("New password").fill(newSecret());
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("button", { name: person.username, exact: true })).toBeVisible();

    await page.goBack();
    expect(page.url().includes(code), "history holds the code").toBe(false);
    expect(
      requests.filter((sent) => sent.includes(code)).length,
      "requests carrying the code",
    ).toBe(0);
  } finally {
    await platform.dispose();
    await own.dispose();
  }
});
