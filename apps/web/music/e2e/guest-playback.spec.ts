import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { PlatformSdk } from "@media/sdk/promise";

import { refuseQueryOnce } from "../../movies/e2e/session/identity";
import { audioSeconds, watchMedia } from "./audio";
import { FIRST_SONG, SECOND_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addHouseholdLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";
import type { Person } from "./people";

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe.configure({ mode: "serial" });

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let media: MediaService | undefined;

let folder = "";

let title = "";

let host: PlatformSdk;

let person: Person;

let album: Awaited<ReturnType<PlatformSdk["music"]["albums"]["list"]>>["page"][number];

let songs: Awaited<ReturnType<PlatformSdk["music"]["albums"]["tracks"]>>["page"];

let policy: Awaited<ReturnType<PlatformSdk["core"]["guests"]["status"]>>;

test.beforeAll(async () => {
  if (stack === null) return;
  test.setTimeout(240_000);
  const library = await writeMusicLibrary(12);
  folder = library.root;
  title = library.album;
  media = await startMediaService(stack, folder);
  await addHouseholdLibrary(stack, folder);
  person = await createPerson(stack, "guest-listener-host", "admin");
  host = await signInClient(stack, person);
  policy = await host.core.guests.status();
  await host.core.guests.configure({
    enabled: true,
    address: `http://localhost:${stack.musicPort}`,
  });
  const albums = await host.music.albums.list({ paginationOpts: { numItems: 100, cursor: null } });
  const found = albums.page.find((row) => row.title === title);

  if (found === undefined) throw new Error("Fixture album missing");
  album = found;
  songs = (
    await host.music.albums.tracks({
      albumId: album.id,
      paginationOpts: { numItems: 100, cursor: null },
    })
  ).page;
});

test.afterAll(async () => {
  if (stack === null) return;
  await host.core.guests.configure({ enabled: policy.enabled, address: policy.address });
  await host.dispose();
  await media?.stop();
  await rm(folder, { recursive: true, force: true });
});

type Item = Parameters<PlatformSdk["music"]["playback"]["get"]>[0]["item"];

const linkFor = (ref: Item) =>
  host.core.guests.links.create({ target: { kind: "item", item: { domain: "music", ref } } });

const openGuest = async (page: Page, url: string): Promise<void> => {
  await watchMedia(page);
  await page.goto(url).catch(() => {
    throw new Error("Guest navigation failed");
  });
  await expect(page.getByRole("heading", { name: "Open as a guest" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Display name").fill("Visitor");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/music\/guest$/u);
};

const play = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => audioSeconds(page)).toBeGreaterThan(0.5);
};

const noHouseholdControls = async (page: Page): Promise<void> => {
  await expect(page.getByRole("link")).toHaveCount(0);
  await Promise.all(
    [
      "Home",
      "Search",
      "Library",
      "Like",
      "Add to playlist",
      "Devices",
      "Connect",
      "Cast",
      "Start a Jam",
      "Settings",
      "Download",
    ].map((name) => expect(page.getByRole("button", { name, exact: true })).toHaveCount(0)),
  );
};

test("an album link plays two songs in order with only its permitted queue", async ({ page }) => {
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const link = await linkFor({ type: "album", id: album.id });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("region", { name: "Queue" }).getByRole("button")).toHaveCount(2);
  await noHouseholdControls(page);
  await play(page);
  const player = page.getByRole("region", { name: "Player" });
  await expect(player).toContainText(FIRST_SONG);
  await expect(player).toContainText(SECOND_SONG, { timeout: 30_000 });
  await expect.poll(() => audioSeconds(page)).toBeGreaterThan(0.5);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => audioSeconds(page)).toBe(0);
  await page.getByRole("slider", { name: "Seek", exact: true }).press("Home");
  await page.getByRole("slider", { name: "Seek", exact: true }).press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Seek", exact: true })).toHaveAttribute(
    "aria-valuenow",
    "1000",
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(player).toContainText(FIRST_SONG);
  expect(errors).toEqual([]);
});

test("a song link has one song and every household route returns to its share", async ({
  page,
}) => {
  const song = songs[0];

  if (song === undefined) throw new Error("Fixture song missing");
  const link = await linkFor({ type: "track", id: song.id });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: song.title, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Queue" }).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await play(page);
  await [
    "/music/",
    "/music/search",
    `/music/albums/${album.id}`,
    "/music/settings",
    "/music/likes",
    "/music/playlists",
  ].reduce(async (previous, path) => {
    await previous;
    await page.goto(path);
    await expect(page).toHaveURL(/\/music\/guest$/u);
    await expect(page.getByRole("heading", { name: song.title, exact: true })).toBeVisible();
  }, Promise.resolve());
  await expect(page.getByRole("button", { name: `Play ${SECOND_SONG}`, exact: true })).toHaveCount(
    0,
  );
  await noHouseholdControls(page);
});

test("a household member opening the share route goes to music home", async ({ page }) => {
  await signIn(page, person);
  await page.goto("/music/guest");
  await expect(page).toHaveURL(/\/music\/?$/u);
  await expect(page.getByRole("navigation").first()).toBeVisible();
});

for (const reason of ["revoked", "turned off", "maker stopped"] as const) {
  test(`playback stops when the link is ${reason}`, async ({ page }) => {
    const maker =
      reason === "maker stopped" && stack !== null
        ? await signInClient(stack, await createPerson(stack, "stopped-music-host", "member"))
        : host;

    try {
      if (maker !== host) {
        const me = await maker.core.auth.sessions.current();
        await host.core.guests.allow({ userId: me.userId, allowed: true });
      }

      const link = await maker.core.guests.links.create({
        target: { kind: "item", item: { domain: "music", ref: { type: "album", id: album.id } } },
      });

      await openGuest(page, link.url);
      await play(page);

      if (reason === "revoked") await host.core.guests.links.revoke({ linkId: link.linkId });
      else if (reason === "turned off")
        await host.core.guests.configure({
          enabled: false,
          address: `http://localhost:${stack?.musicPort}`,
        });
      else {
        const me = await maker.core.auth.sessions.current();

        await host.core.guests.allow({ userId: me.userId, allowed: false });
      }

      await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
      await expect.poll(() => audioSeconds(page)).toBe(0);
      await expect(page.getByRole("region", { name: "Player" })).toHaveCount(0);
    } finally {
      if (reason === "turned off")
        await host.core.guests.configure({
          enabled: true,
          address: `http://localhost:${stack?.musicPort}`,
        });

      if (maker !== host) await maker.dispose();
    }
  });
}

test("the server ends buffered audio at link expiry despite a fast browser clock", async ({
  page,
}) => {
  if (stack === null) return;
  const link = await linkFor({ type: "album", id: album.id });

  const response = await fetch(`${stack.platformUrl}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({
      path: "_system/frontend/patchDocumentsFields",
      args: { table: "shareLinks", ids: [link.linkId], fields: { expiresAt: Date.now() + 15_000 } },
      format: "json",
    }),
  });

  expect(response.ok).toBe(true);
  expect(await response.text()).toMatch(/^\{\s*"status"\s*:\s*"success"/u);
  await openGuest(page, link.url);
  await page.clock.setFixedTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
  await play(page);
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => audioSeconds(page)).toBe(0);
});

for (const query of ["music/playback:get", "music/playback:tracks"]) {
  for (const code of ["internal", "unauthenticated"] as const) {
    test(`${query} ${code} recovers without treating the link as gone`, async ({ page }) => {
      const refused = await refuseQueryOnce(page, query, code);
      const link = await linkFor({ type: "album", id: album.id });
      await openGuest(page, link.url);

      if (code === "internal") {
        await expect(page.getByRole("heading", { name: "Can't reach the server" })).toBeVisible();
        await page.getByRole("button", { name: "Try again", exact: true }).click();
      }

      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      expect(refused()).toBe(1);
      await play(page);
    });
  }
}
