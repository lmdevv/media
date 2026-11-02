import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { mediaPort } from "../harness/config.ts";
import type { TimedEvent } from "../harness/globals";

const SONG = "song-2.mp3";

const media = `http://127.0.0.1:${mediaPort}`;

const SONG_MS = 90_000;

const FIRST_AUDIO_LIMIT_MS = 1500;

const SEEK_AUDIO_LIMIT_MS = 1500;

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

const control = async (request: APIRequestContext, action: string): Promise<void> => {
  expect((await request.post(`${media}/control/${action}`)).ok()).toBe(true);
};

const longestStill = async (page: Page): Promise<number> => {
  let longest = 0;
  let last: { readonly positionMs: number; readonly at: number } | null = null;

  for (const event of await events(page)) {
    if (event.type !== "time") continue;

    if (last === null || event.positionMs > last.positionMs) {
      if (last !== null) longest = Math.max(longest, Math.round(event.at - last.at));
      last = { positionMs: event.positionMs, at: event.at };
    }
  }

  return longest;
};

const coldCache = (request: APIRequestContext): Promise<void> => control(request, "cold");

const cut = (request: APIRequestContext, bytes: number, mode: "abort" | "end" | "hang") =>
  control(request, `cut?bytes=${bytes}&mode=${mode}`);

const songUrls = (page: Page): ReadonlyArray<string> => {
  const seen: Array<string> = [];

  page.on("request", (request) => {
    if (request.url().includes(SONG)) seen.push(request.url());
  });

  return seen;
};

const seek = (page: Page, positionMs: number) =>
  page.evaluate((target) => {
    window.harness?.engine.seek(target);

    return performance.now();
  }, positionMs);

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

const load = (page: Page, file: string, startMs: number, autoplay: boolean, durationMs = SONG_MS) =>
  page.evaluate(
    async ([name, start, play, duration]) => {
      const startedAt = performance.now();

      await window.harness?.load(name, start, play, duration);

      return startedAt;
    },
    [file, startMs, autoplay, durationMs] as const,
  );

test.beforeEach(async ({ page }) => {
  await page.goto(`/engine.html?media=${mediaPort}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
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
    expect(responses[0]).toMatchObject({ method: "GET", status: 200, contentType: "audio/aac" });
    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(1000);
    expect(await ofType(page, "error")).toEqual([]);
  });
}

test("seeks ahead of and behind what is transcoded so far, at once", async ({ page, request }) => {
  const responses = songResponses(page);
  const urls = songUrls(page);

  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true);
  await waitForEvent(page, "playing");
  expect(responses[0]?.contentType).toBe("audio/aac");

  const seekedAt = await seek(page, 80_000);

  await waitForEvent(page, "playing", 2);
  const resumed = (await ofType(page, "playing")).at(-1);
  const seekAudioMs = (resumed?.at ?? Number.NaN) - seekedAt;

  console.log(`cold seek ahead: playing after ${seekAudioMs.toFixed(0)} ms`);
  test.info().annotations.push({ type: "seek-audio-ms", description: seekAudioMs.toFixed(0) });
  expect(seekAudioMs).toBeLessThan(SEEK_AUDIO_LIMIT_MS);
  expect(urls.some((url) => url.includes("start=80000"))).toBe(true);
  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(80_200);
  expect(await lastPosition(page)).toBeLessThan(85_000);
  expect(responses.map((response) => response.method)).not.toContain("HEAD");

  await seek(page, 5000);
  await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(5200);
  expect(await lastPosition(page)).toBeLessThan(9000);
  expect(await ofType(page, "error")).toEqual([]);
  expect(await ofType(page, "ended")).toEqual([]);
});

test("seeks once a media service busy with other seeks has room", async ({ page, request }) => {
  const statuses: Array<number> = [];

  page.on("response", (response) => {
    if (response.url().includes("start=") && response.status() !== 0) {
      statuses.push(response.status());
    }
  });

  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true);
  await waitForEvent(page, "playing");

  await control(request, "busy?ms=1500");
  await seek(page, 60_000);

  await expect.poll(() => lastPosition(page), { timeout: 20_000 }).toBeGreaterThan(60_200);
  expect(await lastPosition(page)).toBeLessThan(65_000);
  expect(statuses[0]).toBe(503);
  expect(statuses.at(-1)).toBe(200);
  expect(await ofType(page, "error")).toEqual([]);
  expect(await ofType(page, "ended")).toEqual([]);
});

const atSeek = (url: string): boolean => url.includes("start=60000");

test("stops a seek's stream that never starts, and opens it again", async ({ page, request }) => {
  test.setTimeout(90_000);
  const seen: Array<"stopped" | "probed"> = [];

  page.on("requestfailed", (failed) => {
    if (!atSeek(failed.url())) return;

    if (failed.resourceType() === "media") seen.push("stopped");
    else if (failed.resourceType() === "fetch") seen.push("probed");
  });

  page.on("requestfinished", (finished) => {
    if (atSeek(finished.url()) && finished.resourceType() === "fetch") seen.push("probed");
  });

  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true);
  await waitForEvent(page, "playing");

  await cut(request, 0, "hang");
  await seek(page, 60_000);

  await expect.poll(() => lastPosition(page), { timeout: 40_000 }).toBeGreaterThan(60_200);
  expect(seen.indexOf("stopped")).toBeGreaterThanOrEqual(0);
  expect(seen.slice(0, seen.indexOf("stopped"))).not.toContain("probed");
  expect(await ofType(page, "error")).toEqual([]);
  expect(await ofType(page, "ended")).toEqual([]);
});

for (const mode of ["abort", "end", "hang"] as const) {
  test(`carries on when a live stream is cut off mid-song (${mode})`, async ({
    browserName,
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const urls = songUrls(page);

    await coldCache(request);
    await cut(request, 64_000, mode);
    await load(page, `${SONG}?p=aac-128`, 0, true);
    await waitForEvent(page, "playing");

    await expect.poll(() => lastPosition(page), { timeout: 30_000 }).toBeGreaterThan(9000);
    console.log(`${mode}: ${urls.map((url) => new URL(url).search).join(" ")}`);
    console.log(`${mode}: position stood still for at most ${String(await longestStill(page))} ms`);

    if (mode === "end" || (mode === "hang" && browserName === "webkit")) {
      expect(urls.some((url) => url.includes("start="))).toBe(true);
    }

    expect(await ofType(page, "ended")).toEqual([]);
    expect(await ofType(page, "advanced")).toEqual([]);
    expect(await ofType(page, "error")).toEqual([]);
  });
}

test("reports an error when a cut-off stream cannot be reopened", async ({ page, request }) => {
  await coldCache(request);
  await cut(request, 64_000, "abort");
  await load(page, `${SONG}?p=aac-128`, 0, true);
  await waitForEvent(page, "playing");
  await control(request, "fail-aac");

  try {
    await waitForEvent(page, "error");
    expect(await ofType(page, "ended")).toEqual([]);
  } finally {
    await control(request, "pass-aac");
  }
});

test("reports a refused stream URL as expired when a seek opens the song again", async ({
  page,
  request,
}) => {
  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true);
  await waitForEvent(page, "playing");
  await control(request, "expire-urls");

  try {
    await seek(page, 80_000);
    await waitForEvent(page, "error");
    expect(
      (await ofType(page, "error")).map((event) => event.type === "error" && event.reason),
    ).toEqual(["expired"]);
  } finally {
    await control(request, "renew-urls");
  }
});

test("ends a song whose stream ends near its catalogued length", async ({ page, request }) => {
  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true, SONG_MS + 1000);
  await waitForEvent(page, "playing");
  await seek(page, SONG_MS - 3000);
  await waitForEvent(page, "ended");
  expect(await ofType(page, "error")).toEqual([]);
});

test("ends a song whose catalogued length is too long once nothing is left", async ({
  page,
  request,
}) => {
  await coldCache(request);
  await load(page, `${SONG}?p=aac-128`, 0, true, SONG_MS + 20_000);
  await waitForEvent(page, "playing");
  await seek(page, SONG_MS - 3000);
  await waitForEvent(page, "ended");
  expect(await ofType(page, "error")).toEqual([]);
});

test("opens an uncached song mid-way, paused, and plays from there", async ({ page, request }) => {
  await coldCache(request);
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
