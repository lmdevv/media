import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { FIRST_SONG, SECOND_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import { NO_STACK, createPerson, reachableStack, signIn, signInClient } from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** How far the page's playing audio has got, in seconds; 0 while nothing plays. */
const audioSeconds = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...(window.musicTestMedia ?? [])].map((media) => (media.paused ? 0 : media.currentTime)),
    ),
  );

declare global {
  interface Window {
    musicTestMedia?: Set<HTMLMediaElement>;
  }
}

let media: MediaService | undefined;

let album = "";

test.beforeAll(async () => {
  if (stack === null) return;

  const library = await writeMusicLibrary();
  const folder = library.root;

  album = library.album;
  media = await startMediaService(stack, folder);

  const admin = await createPerson(stack, "music-admin", "admin");
  const platform = await signInClient(stack, admin);

  try {
    const { libraryId } = await platform.core.libraries.create({
      name: `Music ${admin.username}`,
      kind: "music",
      folders: [folder],
    });

    await platform.core.permissions.grants.set({
      resource: { type: "library", id: libraryId },
      principal: { kind: "household" },
      level: "view",
    });

    await expect
      .poll(async () => (await platform.core.libraries.get({ libraryId })).scan?.status, {
        timeout: 60_000,
      })
      .toBe("succeeded");
  } finally {
    await platform.dispose();
  }
});

test.afterAll(async () => {
  await media?.stop();
});

test("one sign-in at / opens /music signed in; a song plays and moves on to the next", async ({
  page,
}) => {
  if (stack === null) return;

  await page.addInitScript({
    content: `
      window.musicTestMedia = new Set();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.musicTestMedia.add(this);
        return play.call(this);
      };
    `,
  });

  const person = await createPerson(stack, "listener", "member");

  await signIn(page, person);
  await page.goto("/music/");

  await expect(page).toHaveURL(/\/music\/$/u);
  await expect(page.getByLabel("Username")).toHaveCount(0);

  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await expect(page.getByRole("heading", { name: album })).toBeVisible();

  // A desktop row plays on a double click, as old music's did; its play button shows on hover.
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
    .dblclick();

  const player = page.getByRole("region", { name: "Player" });

  await expect(player.getByText(FIRST_SONG)).toBeVisible();
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(player.getByText(SECOND_SONG)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
});

test("a signed-out browser that opens /music goes to / to sign in", async ({ page }) => {
  await page.goto("/music/");
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByLabel("Username")).toBeVisible();
});
