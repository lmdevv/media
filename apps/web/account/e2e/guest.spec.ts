import { expect, test } from "@playwright/test";

import { createPerson, signIn } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

test("a guest code leaves the address before the name form renders", async ({ page }) => {
  await page.goto("/guest#mg_invalid.secret");
  await expect(page.getByRole("heading", { name: "Watch as a guest" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Display name").fill("Visitor");
  await page.getByRole("button", { name: "Watch", exact: true }).click();
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
