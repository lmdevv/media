/**
 * HtmlAudioEngine in a real browser against generated audio served with byte ranges. The page
 * routes the engine's output through a Web Audio worklet that measures silence between sounds.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mediaPort } from "../harness/config.ts";
import type { TimedEvent } from "../harness/globals";

const events = (page: Page): Promise<ReadonlyArray<TimedEvent>> =>
  page.evaluate(() => [...(window.harness?.events ?? [])]);

const ofType = async (page: Page, type: TimedEvent["type"]): Promise<ReadonlyArray<TimedEvent>> =>
  (await events(page)).filter((event) => event.type === type);

const waitForEvent = (page: Page, type: TimedEvent["type"], count = 1): Promise<void> =>
  expect
    .poll(async () => (await ofType(page, type)).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);

/** The latest `time` position the engine reported. */
const lastPosition = async (page: Page): Promise<number> => {
  const times = await ofType(page, "time");
  const last = times.at(-1);

  return last?.type === "time" ? last.positionMs : -1;
};

/** Milliseconds from the first `advanced` (the old song's `ended`) to the next `playing`. */
const eventGap = async (page: Page): Promise<number> => {
  const all = await events(page);
  const advanced = all.findIndex((event) => event.type === "advanced");
  const playing = all.slice(advanced).find((event) => event.type === "playing");

  return (playing?.at ?? Number.NaN) - (all[advanced]?.at ?? Number.NaN);
};

test.beforeEach(async ({ page }) => {
  await page.goto(`/engine.html?media=${mediaPort}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("plays and reports time at least four times a second", async ({ page }) => {
  await page.evaluate(() => window.harness?.load("tone-c.flac", 0, true));
  await waitForEvent(page, "playing");
  await page.waitForTimeout(1500);

  const all = await events(page);
  const playingAt = all.find((event) => event.type === "playing")?.at ?? 0;
  const ticks = all.filter((event) => event.type === "time" && event.at > playingAt);
  const span = (ticks.at(-1)?.at ?? 0) - (ticks[0]?.at ?? 0);
  const rate = ((ticks.length - 1) / span) * 1000;

  console.log(`time events: ${rate.toFixed(1)} Hz`);
  expect(rate).toBeGreaterThanOrEqual(4);
  expect(await lastPosition(page)).toBeGreaterThan(1000);
});

for (const file of ["tone-a.wav", "tone-c.flac", "tone-d.mp3", "tone-e.opus"]) {
  test(`plays ${file}`, async ({ page }) => {
    await page.evaluate((name) => window.harness?.load(name, 0, true), file);
    await waitForEvent(page, "playing");
    expect(await ofType(page, "error")).toEqual([]);
  });
}

test("starts at the requested position, then seeks", async ({ page }) => {
  await page.evaluate(() => window.harness?.load("tone-a.wav", 1500, false));
  await waitForEvent(page, "paused");
  expect(await lastPosition(page)).toBe(1500);

  await page.evaluate(() => window.harness?.engine.play());
  await waitForEvent(page, "playing");
  await page.waitForTimeout(400);
  expect(await lastPosition(page)).toBeGreaterThanOrEqual(1500);

  await page.evaluate(() => {
    window.harness?.engine.seek(200);
  });

  await page.waitForTimeout(400);
  const position = await lastPosition(page);
  expect(position).toBeGreaterThanOrEqual(200);
  expect(position).toBeLessThan(1500);
});

test("advances to the preloaded song with a measured gap", async ({ page }) => {
  await page.evaluate(() => {
    window.harness?.resetGap();
    window.harness?.preload("tone-b.wav");
  });

  await page.evaluate(() => window.harness?.load("tone-a.wav", 0, true));
  await waitForEvent(page, "advanced", 1);
  await page.evaluate(() => {
    window.harness?.preload("tone-a.wav");
  });

  await waitForEvent(page, "advanced", 2);
  await page.waitForTimeout(800);

  const advanced = await ofType(page, "advanced");
  const gap = await page.evaluate(() => window.harness?.gap());

  console.log(
    `gap between songs: ${gap?.longestGapMs.toFixed(1) ?? "?"} ms of silence (longest of 2), ` +
      `ended → playing ${(await eventGap(page)).toFixed(1)} ms`,
  );

  test.info().annotations.push({
    type: "gap-ms",
    description: gap?.longestGapMs.toFixed(1) ?? "unknown",
  });

  expect(advanced.map((event) => (event.type === "advanced" ? event.key : ""))).toEqual([
    "tone-b.wav",
    "tone-a.wav",
  ]);

  expect(await ofType(page, "ended")).toEqual([]);
  expect(gap?.soundMs ?? 0).toBeGreaterThan(6000);
  // The HTML audio engine is "nearly gapless": a small but nonzero gap is expected.
  expect(gap?.longestGapMs ?? Number.POSITIVE_INFINITY).toBeLessThan(250);
});

test("advances without Web Audio routing (production output path)", async ({ page }) => {
  await page.goto(`/engine.html?media=${mediaPort}&capture=0`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    window.harness?.preload("tone-b.wav");
  });

  await page.evaluate(() => window.harness?.load("tone-a.wav", 0, true));
  await waitForEvent(page, "advanced");
  await waitForEvent(page, "playing", 2);
  console.log(`ended → playing (no Web Audio): ${(await eventGap(page)).toFixed(1)} ms`);
  expect(await ofType(page, "ended")).toEqual([]);
});

test("reports ended when nothing is preloaded", async ({ page }) => {
  await page.evaluate(() => window.harness?.load("tone-d.mp3", 2500, true));
  await waitForEvent(page, "ended");
  expect(await ofType(page, "advanced")).toEqual([]);
});

test("reports an error for a missing file without hanging the load", async ({ page }) => {
  await page.evaluate(() => window.harness?.load("missing.flac", 0, true));
  const errors = await ofType(page, "error");

  expect(errors).toHaveLength(1);
  expect(errors[0]?.type === "error" ? errors[0].reason : null).toMatch(/network|unsupported/u);
});

test("unload stops the output", async ({ page }) => {
  await page.evaluate(() => window.harness?.load("tone-a.wav", 0, true));
  await waitForEvent(page, "playing");
  await page.evaluate(() => {
    window.harness?.engine.unload();
  });

  const before = await page.evaluate(() => window.harness?.gap());
  const eventCount = (await events(page)).length;
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.harness?.gap());

  expect(after?.soundMs ?? 0).toBeLessThan((before?.soundMs ?? 0) + 30);
  expect((await events(page)).length).toBe(eventCount);
});
