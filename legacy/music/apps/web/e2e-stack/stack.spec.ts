import { Device, PlaybackState } from "@music/commands/models";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";

import { ADMIN, cli, expectAudioPast, isPlayingAudio, signIn } from "./support";

test.describe.configure({ mode: "serial" });

let apiKey = "";

const decodeDevices = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Device)));

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(PlaybackState));

const openFirstAlbum = async (page: Page): Promise<string> => {
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  const card = page.locator("main a[href^='/albums/']").first();
  await expect(card).toBeVisible();
  const name = (await card.getAttribute("aria-label")) ?? (await card.textContent()) ?? "";
  await card.click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  const title = (await page.getByRole("heading", { level: 1 }).first().textContent()) ?? name;
  expect(title.length).toBeGreaterThan(0);

  return title;
};

test("first run: create the admin, add /music, and the real scanner indexes it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByRole("heading", { name: "Where's your music?" })).toBeVisible();
  await page.getByLabel("Library folder").fill("/music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await expect(page.getByRole("heading", { name: "Your library is ready" })).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Open my library" }).click();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.locator("main img").first()).toBeVisible();
});

test("an album plays real audio, pauses, and skips", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 2);

  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  await bar.getByRole("button", { name: "Play", exact: true }).click();
  await expectAudioPast(page, 1);
  const before = await page.locator("[role=row][aria-current=true]").first().textContent();
  await bar.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => page.locator("[role=row][aria-current=true]").first().textContent())
    .not.toBe(before);
  await expectAudioPast(page, 1);
});

test("search finds songs from the scanned library", async ({ page }) => {
  await signIn(page);
  const album = await openFirstAlbum(page);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search/);
  const word = album.split(" ")[0] ?? album;
  await page.locator("#search-input").fill(word);
  await expect(page.getByText("Top result")).toBeVisible();
});

test("an API key drives the CLI, and the CLI controls the browser's playback", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill("stack e2e");
  await page.getByRole("button", { name: "Create key" }).click();
  apiKey = (await page.getByTestId("new-api-key").textContent())?.trim() ?? "";
  expect(apiKey).toMatch(/^mk_/);
  await page.getByRole("button", { name: "Done" }).click();

  expect(cli(apiKey, ["whoami"])).toContain(ADMIN.email);

  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  cli(apiKey, ["pause"]);
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  cli(apiKey, ["resume"]);
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 1);
});

test("playback moves to a second browser and the first one stops", async ({ page, browser }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 2);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();
  await signIn(phone);
  await expect(phone.getByRole("button", { name: /Open Now Playing/ })).toBeVisible();

  const devices = decodeDevices(cli(apiKey, ["devices", "list", "--json"]));
  const state = decodeState(cli(apiKey, ["now", "--json"]));

  const target = devices.find((device) => device.online && device.id !== state.activeDevice?.id);
  expect(target).toBeDefined();
  cli(apiKey, ["playback", "transfer", target?.id ?? ""]);

  await expect.poll(() => isPlayingAudio(page)).toBe(false);
  await expectAudioPast(phone, 1);
  await expect(page.getByText(/Playing on /).first()).toBeVisible();
  await other.close();
});
