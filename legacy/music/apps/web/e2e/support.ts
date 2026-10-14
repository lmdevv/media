import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { setupStatus } from "@music/sdk/functions";
import { expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { e2eConvexUrl } from "./env";

/** The admin the seed script creates. */
export const ADMIN = {
  email: "admin@music.local",
  password: "password123",
  name: "Lucía",
} as const;

const backendDir = fileURLToPath(new URL("../../../packages/backend", import.meta.url));

/**
 * Runs the backend seed script: with no flag it ensures the admin, a library, and its songs;
 * with `--pending` it finishes queued scans, standing in for the media service.
 */
export const seed = (pending = false): void => {
  execFileSync("node", ["scripts/seed.ts", ...(pending ? ["--pending"] : [])], {
    cwd: backendDir,
    stdio: "pipe",
  });
};

/** Registers a stand-in phone called `name` and moves playback to it, as another device would. */
export const seedDevice = (name: string): void => {
  execFileSync("node", ["scripts/seed.ts", "--device", name], { cwd: backendDir, stdio: "pipe" });
};

/** Whether the backend already has an account (first-run setup has happened). */
export const hasUsers = async (): Promise<boolean> =>
  (await new ConvexHttpClient(e2eConvexUrl()).query(setupStatus, {})).hasUsers;

/** Signs in through the sign-in screen and waits for Home. */
export const signIn = async (
  page: Page,
  email: string = ADMIN.email,
  password: string = ADMIN.password,
): Promise<void> => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
};

/**
 * Signs in as the admin on `admin`, creates an invite, and joins with it as a new member in a
 * fresh browser context. Returns the member's page, at Home; close its context when done.
 */
export const joinAsNewMember = async (admin: Page, browser: Browser): Promise<Page> => {
  await signIn(admin);
  await admin.goto("/settings/people");
  await admin.getByRole("button", { name: "Invite" }).click();
  await admin.getByRole("button", { name: "Create invite" }).click();

  const link = (await admin.getByTestId("invite-link").textContent()) ?? "";

  expect(link).toContain("/invite/");

  const member = await (await browser.newContext()).newPage();

  await member.goto(link);
  await expect(member.getByRole("heading", { name: /invited you/ })).toBeVisible();
  await member.getByLabel("Email").fill(`${unique("guest").replace(" ", "-")}@music.local`);
  await member.getByLabel("Your name").fill("Mateo");
  await member.getByLabel("Choose a password").fill("password123");
  await member.getByRole("button", { name: "Join" }).click();
  await expect(member.getByRole("navigation", { name: "Library" })).toBeVisible();

  return member;
};

/** A name no earlier run used, for things tests create. */
export const unique = (prefix: string): string => `${prefix} ${Date.now().toString(36)}`;
