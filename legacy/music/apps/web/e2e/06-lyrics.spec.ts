import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { seed, signIn } from "./support";

test.beforeAll(() => {
  // Idempotent: the songs and their lyrics (synced on "Safe From Harm", none on "One Love").
  seed();
});

/** The "Look up lyrics online" switch on the Libraries screen. */
const remoteLyricsSwitch = (page: Page): Locator =>
  page.getByRole("switch", { name: /^Look up lyrics online/ });

/** Turns lyrics lookups on LRCLIB on or off from the Libraries screen. */
const setRemoteLyrics = async (page: Page, on: boolean): Promise<void> => {
  await page.goto("/settings/libraries");

  const toggle = remoteLyricsSwitch(page);

  await expect(toggle).toBeEnabled();

  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await expect(toggle).toBeEnabled();
};

/** Plays Blue Lines from "Safe From Harm" and opens Now Playing; returns its parts. */
const playBlueLines = async (page: Page) => {
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  // The album's Play, not the player bar's, which an earlier run may have left paused.
  await page.getByRole("main").getByRole("button", { name: "Play", exact: true }).click();

  const bar = page.getByRole("region", { name: "Player" });

  await expect(bar.getByRole("button", { name: "Safe From Harm", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Open Now Playing" }).click();

  const nowPlaying = page.getByRole("dialog", { name: "Now Playing" });
  const lyrics = nowPlaying.getByRole("region", { name: "Lyrics" });

  return {
    bar,
    nowPlaying,
    lyrics,
    current: lyrics.locator('[aria-current="true"]'),
    line: (index: number) => lyrics.locator(`[data-line="${String(index)}"]`),
    /** The scroll position of the lines. */
    scrollTop: async (): Promise<number> =>
      lyrics.locator("ol").evaluate((list) => list.parentElement?.scrollTop ?? Number.NaN),
  };
};

/** Opens the synced lyrics of "Safe From Harm" and waits until they follow playback. */
const openSyncedLyrics = async (page: Page) => {
  const parts = await playBlueLines(page);

  await parts.nowPlaying.getByRole("button", { name: "Lyrics", exact: true }).click();
  await expect(parts.lyrics.getByText("SYNCED LYRICS · FROM FILE")).toBeVisible();
  await expect(parts.current).toBeVisible({ timeout: 15_000 });

  return parts;
};

/** Waits, a frame at a time, until line `index` is the sung one. */
const waitForSung = async (page: Page, index: number): Promise<void> => {
  await page.waitForFunction(
    (line) =>
      document.querySelector('[data-line][aria-current="true"]')?.getAttribute("data-line") ===
      line,
    String(index),
    { polling: "raf" },
  );
};

test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");

  const pause = page.getByRole("region", { name: "Player" }).getByRole("button", {
    name: "Pause",
    exact: true,
  });

  if (await pause.isVisible()) await pause.click();
});

test("an admin turns looking up lyrics online off and on", async ({ page }) => {
  await signIn(page);
  await setRemoteLyrics(page, true);
  await setRemoteLyrics(page, false);
  await page.reload();
  await expect(remoteLyricsSwitch(page)).toHaveAttribute("aria-checked", "false");

  await setRemoteLyrics(page, true);
  await page.reload();
  await expect(remoteLyricsSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("Sends the title, artist, album, and length of songs without lyrics to LRCLIB."),
  ).toBeVisible();
});

test("synced lyrics follow playback, seek, and come back after a scroll", async ({ page }) => {
  await signIn(page);

  const { nowPlaying, lyrics, current, scrollTop } = await openSyncedLyrics(page);

  // Lines start every 2.5 seconds from 0:01: the sung line moves on with the song.
  await expect(current).toHaveAttribute("data-line", "1", { timeout: 15_000 });
  await expect(current).toHaveAttribute("data-line", "2", { timeout: 5000 });

  const line = lyrics.getByRole("button", { name: /^The water keeps the colour of the sky/ });

  await expect(line).toHaveAccessibleName("The water keeps the colour of the sky, seek to 0:31");
  await line.click();
  await expect(current).toContainText("The water keeps the colour of the sky");
  await expect
    .poll(async () =>
      Number(await nowPlaying.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuenow")),
    )
    .toBeGreaterThanOrEqual(31_000);

  // One wheel turn stops following: the sung line moves on out of view until "Back to current
  // line".
  await waitForSung(page, 12);
  await expect(current).toBeInViewport();
  await lyrics.hover();
  await page.mouse.wheel(0, -1000);
  await expect(current).not.toBeInViewport();

  const back = nowPlaying.getByRole("button", { name: "Back to current line" });
  const away = await scrollTop();

  await expect(back).toBeVisible();
  await waitForSung(page, 13);
  expect(await scrollTop()).toBe(away);
  await expect(current).not.toBeInViewport();
  await back.click();
  await expect(back).toHaveCount(0);
  await expect(current).toBeInViewport();
});

/** Seeks to line `index` by choosing it, and waits until following has put it in place. */
const followFrom = async (page: Page, line: Locator, index: number): Promise<void> => {
  await line.click();
  await waitForSung(page, index);
  // The follow scroll there takes a moment.
  await page.waitForTimeout(1000);
};

test("a wheel turn during a follow scroll stops it where the wheel leaves it", async ({ page }) => {
  await signIn(page);

  const { nowPlaying, current, line, scrollTop } = await openSyncedLyrics(page);

  await followFrom(page, line(8), 8);

  // Below the sung line, for a long follow scroll, and in view, so the click scrolls nothing.
  const far = line(11);

  await expect(far).toBeInViewport({ ratio: 1 });
  const before = await scrollTop();

  await far.click();
  // The click's seek moved the sung line, and its follow scroll started in that frame.
  await waitForSung(page, 11);
  await page.mouse.wheel(0, -1000);

  await expect(nowPlaying.getByRole("button", { name: "Back to current line" })).toBeVisible();
  await expect(current).not.toBeInViewport();
  // Long after any follow scroll would have ended, the lines are still where the wheel put them.
  await page.waitForTimeout(1500);
  expect(await scrollTop()).toBeLessThan(before - 300);
  await expect(current).not.toBeInViewport();
});

test("a scroll no handler saw stops following instead of being scrolled back", async ({ page }) => {
  await signIn(page);

  const { nowPlaying, lyrics, line, scrollTop } = await openSyncedLyrics(page);

  await followFrom(page, line(8), 8);
  await lyrics.locator("ol").evaluate((list) => {
    list.parentElement?.scrollBy({ top: -400, behavior: "instant" });
  });

  const moved = await scrollTop();

  await waitForSung(page, 9);
  await expect(nowPlaying.getByRole("button", { name: "Back to current line" })).toBeVisible();
  expect(await scrollTop()).toBe(moved);
});

test("the sung line stays in place when the window changes size", async ({ page }) => {
  await signIn(page);

  const { current, line } = await openSyncedLyrics(page);

  await followFrom(page, line(8), 8);

  /** How far the sung line's middle is from the middle of the lines' pane, in pixels. */
  const offCentre = async (): Promise<number> =>
    current.evaluate((button) => {
      const pane = button.closest("ol")?.parentElement;

      if (pane === null || pane === undefined) return Number.NaN;
      const sung = button.getBoundingClientRect();
      const box = pane.getBoundingClientRect();

      return Math.abs(sung.top + sung.height / 2 - (box.top + box.height / 2));
    });

  expect(await offCentre()).toBeLessThan(4);
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect.poll(offCentre, { timeout: 1000 }).toBeLessThan(4);
  await expect(current).toHaveAttribute("data-line", "8");
});

test("no line is sung in a gap after a line's end, and a two-row line keeps its rows", async ({
  page,
}) => {
  await signIn(page);

  const { lyrics, current, line } = await openSyncedLyrics(page);
  const last = lyrics.getByRole("button", { name: /^The harbour sleeps and so do we/ });

  await last.click();
  await expect(current).toHaveAttribute("data-line", "17");

  // It ends at 0:46, and the next line starts at 0:50.
  await expect(lyrics.locator("[aria-current]")).toHaveCount(0, { timeout: 5000 });
  await expect(last).toBeInViewport();

  const twoRows = line(18);

  await expect(current).toHaveAttribute("data-line", "18", { timeout: 6000 });
  await expect(twoRows).toHaveAccessibleName(
    "Morning finds the harbour still\nand the gulls come back to the glass, seek to 0:50",
  );

  // Rendered, not collapsed into one flowing sentence: the second row starts after the break.
  expect(
    await twoRows.evaluate((button) => (button instanceof HTMLElement ? button.innerText : "")),
  ).toBe("Morning finds the harbour still\nand the gulls come back to the glass");
});

test("a song without lyrics is looked up online, or has none with lookups off", async ({
  page,
}) => {
  await signIn(page);
  await setRemoteLyrics(page, true);

  const { nowPlaying, lyrics } = await openSyncedLyrics(page);

  // No media service runs here, so the lookup for "One Love" stays queued.
  await nowPlaying.getByRole("button", { name: "Next", exact: true }).first().click();
  await expect(lyrics.getByText("Looking for lyrics…")).toBeVisible();
  await nowPlaying.getByRole("button", { name: "Hide lyrics" }).click();
  await expect(nowPlaying.getByRole("button", { name: "Lyrics (looking for them)" })).toBeEnabled();

  await page.keyboard.press("Escape");
  await setRemoteLyrics(page, false);
  await page
    .getByRole("region", { name: "Player" })
    .getByRole("button", { name: "Open Now Playing" })
    .click();
  await expect(nowPlaying.getByRole("button", { name: "No lyrics for this song" })).toBeDisabled();

  await page.keyboard.press("Escape");
  await setRemoteLyrics(page, true);
});
