import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createPerson, openPlatform, signIn } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

const signedInHome = async (page: Page, person: Person): Promise<void> => {
  await signIn(page, person);
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
};

test("a person sets the name they go by, sees it greet them, and clears it", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");
  const name = page.getByRole("textbox", { name: "Name", exact: true });

  await signedInHome(page, person);
  await page.goto("/settings");
  await name.fill("Lucía Pérez");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByRole("status")).toHaveText("Name saved.");
  await expect(page.getByRole("banner").getByText("Lucía Pérez")).toBeVisible();

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Hi, Lucía Pérez." })).toBeVisible();

  await page.goto("/settings");
  await name.fill("");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByRole("status")).toHaveText("Name saved.");

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
});

test("a person sees their own devices and signs another browser out", async ({ page, browser }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "aiko");
  const elsewhere = await browser.newContext();
  const laptop = await elsewhere.newPage();
  const script = openPlatform(stack);

  try {
    await signedInHome(laptop, person);
    await script.session.signInWithPassword(person);
    await signedInHome(page, person);
    await page.goto("/devices");

    const list = page.getByRole("list", { name: "Signed-in devices" });

    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.getByRole("listitem").first()).toContainText("Current");
    await expect(list.getByText("Password sign-in")).toBeVisible();

    const other = list.getByRole("listitem").nth(2);

    await other.getByRole("button", { name: /^Sign out/u }).click();
    await expect(other.getByRole("note")).toContainText("has to sign in again.");
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(2);

    await laptop.reload();
    await expect(laptop.getByLabel("Username")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  } finally {
    await script.dispose();
    await elsewhere.close();
  }
});

test("a person makes an API key, sees it listed with its last use but never its secret, and revokes it", async ({
  page,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "mateo");
  const keys = page.getByRole("list", { name: "API keys" });
  const script = openPlatform(stack);

  try {
    await signedInHome(page, person);
    await page.goto("/api-keys");
    await expect(page.getByText("No API keys.")).toBeVisible();

    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Home Assistant");
    await page.getByRole("checkbox").first().click();
    await page.getByRole("button", { name: "Create key" }).click();

    const secret = page.getByText(/^mk_[a-z0-9]+\.[\w-]{43}$/u);

    await expect(secret).toBeVisible();

    const key = (await secret.textContent()) ?? "";

    await expect(keys.getByRole("listitem")).toHaveCount(1);
    await expect(keys).toContainText("Home Assistant");
    await expect(keys).toContainText("Never used");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(secret).toBeHidden();

    await script.session.signInWithApiKey(key);
    await expect(keys).toContainText("Last used");
    await expect(page.getByText(key.split(".")[1] ?? "")).toBeHidden();

    await keys.getByRole("button", { name: "Revoke Home Assistant" }).click();
    await keys.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("No API keys.")).toBeVisible();
  } finally {
    await script.dispose();
  }
});
