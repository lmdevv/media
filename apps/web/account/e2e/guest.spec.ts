import { expect, test } from "@playwright/test";

import { createPerson, signIn } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

test("a guest code leaves the address before the name form renders", async ({ page }) => {
  await page.goto("/guest#mg_invalid.secret");
  await expect(page.getByRole("heading", { name: "Open as a guest" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Display name").fill("Visitor");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
});

test("a member cancels replacing their sign-in", async ({ page }) => {
  if (stack === null) return;
  const member = await createPerson(stack, "guest-cancel");
  await signIn(page, member);
  await expect(page.getByRole("heading", { name: `Hi, ${member.username}.` })).toBeVisible();
  await page.goto("/guest#mg_invalid.secret");
  await expect(page.getByRole("heading", { name: "Replace this sign-in?" })).toBeVisible();
  await expect(page.getByText(`${member.username} is signed in on this browser.`)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${member.username}.` })).toBeVisible();
});

for (const failed of [false, true]) {
  test(`Leave preserves the member after a ${failed ? "failed" : "missing"} link`, async ({
    page,
    context,
  }) => {
    if (stack === null) return;
    const member = await createPerson(stack, "guest-leave");
    await signIn(page, member);
    await expect(page).toHaveURL(/\/home$/u);
    const household = await context.newPage();
    await household.goto("/home");
    await page.goto(failed ? "/guest#mg_invalid.secret" : "/guest");

    if (failed) {
      await page.getByRole("button", { name: "Continue as a guest" }).click();
      await page.getByLabel("Display name").fill("Visitor");
      await page.getByRole("button", { name: "Open", exact: true }).click();
    }

    await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Hi, ${member.username}.` })).toBeVisible();
    await household.reload();
    await expect(household.getByRole("heading", { name: `Hi, ${member.username}.` })).toBeVisible();
  });
}

test("consent must be renewed when the same member signs in again in another tab", async ({
  page,
  context,
}) => {
  if (stack === null) return;
  const member = await createPerson(stack, "guest-consent");
  await signIn(page, member);
  await expect(page).toHaveURL(/\/home$/u);
  await page.goto("/guest#mg_invalid.secret");
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await expect(page.getByLabel("Display name")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/home");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(other.getByLabel("Username")).toBeVisible();
  await signIn(other, member);
  await expect(other).toHaveURL(/\/home$/u);
  await expect(page.getByRole("heading", { name: "Replace this sign-in?" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveCount(0);
});
