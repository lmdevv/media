import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { audioSeconds, watchMedia } from "./audio";
import { FIRST_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import { NO_STACK, addHouseholdLibrary, createPerson, reachableStack, signIn } from "./people";
import type { Person } from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

let media: MediaService | undefined;

let person: Person | undefined;

let album = "";

test.beforeAll(async () => {
  if (stack === null) return;

  // Long songs, so one keeps playing through each test.
  const library = await writeMusicLibrary(120);

  album = library.album;
  media = await startMediaService(stack, library.root);
  await addHouseholdLibrary(stack, library.root);
  person = await createPerson(stack, "focus", "member");
});

test.afterAll(async () => {
  await media?.stop();
});

const focusedTag = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.tagName ?? null);

/** Whether the element has focus and shows the keyboard focus ring. */
const ringed = (locator: Locator): Promise<boolean> =>
  locator.evaluate(
    (element) => element === document.activeElement && element.matches(":focus-visible"),
  );

/** Signs in, plays the album's first song, and returns the player bar. */
const playFirstSong = async (page: Page): Promise<Locator> => {
  if (person === undefined) throw new Error("No person to sign in as.");

  await watchMedia(page);
  await signIn(page, person);
  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
    .dblclick();

  const player = page.getByRole("region", { name: "Player" });

  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(0.5);

  return player;
};

test("Space pauses after Now Playing, opened from the song title, closes with Escape", async ({
  page,
}) => {
  if (stack === null) return;

  const player = await playFirstSong(page);
  const nowPlaying = page.getByRole("dialog", { name: "Now Playing" });

  await player.getByRole("button", { name: FIRST_SONG, exact: true }).click();
  await expect(nowPlaying).toBeVisible();

  // Now Playing is a full-screen view, so the player's shortcuts work in it.
  await page.keyboard.press(" ");
  await expect(nowPlaying.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
  await page.keyboard.press(" ");
  await expect(
    nowPlaying.getByRole("button", { name: "Pause", exact: true }).first(),
  ).toBeVisible();
  await expect.poll(() => audioSeconds(page)).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(nowPlaying).toBeHidden();
  await expect.poll(() => focusedTag(page)).toBe("BODY");

  await page.keyboard.press(" ");
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => audioSeconds(page)).toBe(0);
  await expect(nowPlaying).toBeHidden();
});

test("Space plays and pauses, and presses nothing, while a button has focus", async ({ page }) => {
  if (stack === null) return;

  const player = await playFirstSong(page);
  const nowPlaying = page.getByRole("dialog", { name: "Now Playing" });

  await player.getByRole("button", { name: "Open Now Playing" }).focus();
  await page.keyboard.press(" ");
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await page.keyboard.press(" ");
  await expect(player.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(nowPlaying).toBeHidden();

  await page.keyboard.press("Enter");
  await expect(nowPlaying).toBeVisible();
});

test("a clicked button keeps no focus; Tab rings the next one and Enter presses it", async ({
  page,
}) => {
  if (stack === null) return;

  const player = await playFirstSong(page);

  await player.getByRole("button", { name: "Previous", exact: true }).click();
  await expect.poll(() => focusedTag(page)).toBe("BODY");

  await page.keyboard.press("Tab");

  const pause = player.getByRole("button", { name: "Pause", exact: true });

  await expect.poll(() => ringed(pause)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("a clicked heart that stops its click keeps no focus, so Enter does not like it again", async ({
  page,
}) => {
  if (stack === null) return;

  const player = await playFirstSong(page);

  // The heart stops its click from reaching the page, as the track list's play buttons do.
  await player.getByRole("button", { name: `Like ${FIRST_SONG}`, exact: true }).click();

  const unlike = player.getByRole("button", { name: `Unlike ${FIRST_SONG}`, exact: true });

  await expect(unlike).toBeVisible();
  await expect.poll(() => focusedTag(page)).toBe("BODY");

  await page.keyboard.press("Enter");
  await expect(unlike).toBeVisible();
});

test("Play on returns focus to its button after a keyboard open, and to nothing after a click", async ({
  page,
}) => {
  if (stack === null) return;

  const player = await playFirstSong(page);
  const trigger = player.getByRole("button", { name: "Play on another device" });
  const popover = page.getByRole("dialog").filter({ hasText: "Play on" });

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect.poll(() => ringed(trigger)).toBe(true);

  await trigger.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect.poll(() => focusedTag(page)).toBe("BODY");
});

test("D closes Play on wherever focus sits in it, and opens it", async ({ page }) => {
  if (stack === null) return;

  const player = await playFirstSong(page);
  const popover = page.getByRole("dialog").filter({ hasText: "Play on" });

  await player.getByRole("button", { name: "Play on another device" }).click();
  await expect(popover).toBeVisible();
  // A click on the popover's padding leaves focus in the popover but outside its device menu.
  await popover.click({ position: { x: 3, y: 3 } });
  expect(
    await popover.evaluate(
      (element) =>
        element.contains(document.activeElement) &&
        document.activeElement?.closest('[role="menu"]') === null,
    ),
  ).toBe(true);
  await page.keyboard.press("d");
  await expect(popover).toBeHidden();

  await page.keyboard.press("d");
  await expect(popover).toBeVisible();
  await page.keyboard.press("d");
  await expect(popover).toBeHidden();
});
