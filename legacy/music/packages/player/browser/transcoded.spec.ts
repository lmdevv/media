/**
 * HtmlAudioEngine on the AAC profiles (`aac-320`, `aac-128`) on a cold cache: the media stub
 * serves them through the media service's real transcoder, so a first play streams ADTS while
 * ffmpeg writes it, and seeks wait for the finished MP4. Runs in Chromium, Firefox, and WebKit
 * (`transcoded-*` projects).
 */
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { mediaPort } from "../harness/config.ts";
import type { TimedEvent } from "../harness/globals";

/** Ninety seconds of MP3: encoding it to AAC at 320 kbps takes several seconds. */
const SONG = "song-2.mp3";

const media = `http://127.0.0.1:${mediaPort}`;

/** Upper bound for the first play of an uncached song; it measures 0.1 to 0.3 seconds. */
const FIRST_AUDIO_LIMIT_MS = 1500;

/** One response for the song, as the browser saw it. */
interface SongResponse {
  readonly method: string;
  readonly status: number;
  readonly contentType: string;
}

const events = (page: Page): Promise<ReadonlyArray<TimedEvent>> =>
  page.evaluate(() => [...(window.harness?.events ?? [])]);

const ofType = async (page: Page, type: TimedEvent["type"]): Promise<ReadonlyArray<TimedEvent>> =>
  (await events(page)).filter((event) => event.type === type);

const waitForEvent = (page: Page, type: TimedEvent["type"], count = 1) =>
  expect
    .poll(async () => (await ofType(page, type)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(count);

const lastPosition = async (page: Page): Promise<number> => {
  const last = (await ofType(page, "time")).at(-1);

  return last?.type === "time" ? last.positionMs : -1;
};

/** Makes the stub forget its transcodes: the next request for each song is a first play. */
const coldCache = async (request: APIRequestContext): Promise<void> => {
  expect((await request.post(`${media}/control/cold`)).ok()).toBe(true);
};

/**
 * Records every response for the song from now on, except the ones WebKit reports with status 0:
 * its media player opens a source twice and drops the first request.
 */
const songResponses = (page: Page): ReadonlyArray<SongResponse> => {
  const seen: Array<SongResponse> = [];

  page.on("response", (response) => {
    if (!response.url().includes(SONG) || response.status() === 0) return;

    seen.push({
      method: response.request().method(),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
    });
  });

  return seen;
};

/** Loads `file` and resolves with the page time the load started at. */
const load = (page: Page, file: string, startMs: number, autoplay: boolean) =>
  page.evaluate(
    async ([name, start, play]) => {
      const startedAt = performance.now();

      await window.harness?.load(name, start, play);

      return startedAt;
    },
    [file, startMs, autoplay] as const,
  );

test.beforeEach(async ({ page }) => {
  await page.goto(`/engine.html?media=${mediaPort}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  // A real click: WebKit keeps the AudioContext suspended until a user gesture.
  await page.locator("body").click();
});

for (const profile of ["aac-320", "aac-128"]) {
  test(`starts an uncached ${profile} song while it is transcoded`, async ({ page, request }) => {
    const responses = songResponses(page);

    await coldCache(request);
    const startedAt = await load(page, `${SONG}?p=${profile}`, 0, true);

    await waitForEvent(page, "playing");
    const playing = (await ofType(page, "playing")).at(0);
    const firstAudioMs = (playing?.at ?? Number.NaN) - startedAt;

    console.log(`${profile} first play: playing after ${firstAudioMs.toFixed(0)} ms`);
    test.info().annotations.push({ type: "first-audio-ms", description: firstAudioMs.toFixed(0) });
    expect(firstAudioMs).toBeLessThan(FIRST_AUDIO_LIMIT_MS);
    // It played the live ADTS stream, not a finished file.
    expect(responses[0]).toMatchObject({ method: "GET", status: 200, contentType: "audio/aac" });
    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(1000);
    expect(await ofType(page, "error")).toEqual([]);
  });
}

test("seeks ahead of and behind what is transcoded so far", async ({ page, request }) => {
  const responses = songResponses(page);

  await coldCache(request);
  await load(page, `${SONG}?p=aac-320`, 0, true);
  await waitForEvent(page, "playing");
  expect(responses[0]?.contentType).toBe("audio/aac");

  // Far ahead of the encoder: the engine waits for the finished file and seeks in it.
  await page.evaluate(() => {
    window.harness?.engine.seek(80_000);
  });

  await waitForEvent(page, "waiting");
  await expect.poll(() => lastPosition(page), { timeout: 30_000 }).toBeGreaterThan(80_200);
  expect(responses.map((response) => response.method)).toContain("HEAD");
  expect(responses.at(-1)).toMatchObject({ method: "GET", contentType: "audio/mp4" });

  // Behind: the finished file seeks at once.
  await page.evaluate(() => {
    window.harness?.engine.seek(5000);
  });

  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(5200);
  expect(await lastPosition(page)).toBeLessThan(9000);
  expect(await ofType(page, "error")).toEqual([]);
});

test("opens an uncached song mid-way, paused, and plays from there", async ({ page, request }) => {
  await coldCache(request);
  // Like a listener resuming a session: the load lands once the finished file is there.
  await load(page, `${SONG}?p=aac-320`, 60_000, false);

  expect(await ofType(page, "paused")).toHaveLength(1);
  expect(await ofType(page, "playing")).toEqual([]);
  expect(await lastPosition(page)).toBe(60_000);

  await page.evaluate(() => window.harness?.engine.play());
  await waitForEvent(page, "playing");
  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(60_200);
  expect(await lastPosition(page)).toBeLessThan(65_000);
  expect(await ofType(page, "error")).toEqual([]);
});

test("restarts an uncached song from the start without waiting", async ({ page, request }) => {
  await coldCache(request);
  await load(page, `${SONG}?p=aac-320`, 0, true);
  await waitForEvent(page, "playing");
  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(2500);

  // Back to the start, as repeat-one does: the live stream opens again from its first byte.
  const seekedAt = await page.evaluate(() => {
    window.harness?.engine.seek(0);

    return performance.now();
  });

  await waitForEvent(page, "playing", 2);
  const restarted = (await ofType(page, "playing")).at(-1);

  expect((restarted?.at ?? Number.NaN) - seekedAt).toBeLessThan(FIRST_AUDIO_LIMIT_MS);
  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(200);
  expect(await lastPosition(page)).toBeLessThan(2500);
  expect(await ofType(page, "error")).toEqual([]);
});
