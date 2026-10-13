/**
 * MseEngine in a real browser: sample-accurate gapless playback measured on a continuous sine cut
 * into three songs, plus loading, seeking, preloading, and failures. The media stub serves the
 * songs through the media service's real transcoder, so the streams and their timing headers are
 * exactly what production sends. Runs in Chromium, Firefox, and WebKit (`gapless-*` projects).
 */
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { mediaPort } from "../harness/config.ts";
import {
  GAPLESS_CUTS,
  GAPLESS_FREQUENCY,
  GAPLESS_RATE,
  gaplessFile,
  HIRES_FIXTURE,
  TRUNCATED_DECLARED_MS,
  TRUNCATED_FIXTURE,
  TRUNCATED_REAL_MS,
} from "../harness/fixtures.ts";
import type { GaplessSource } from "../harness/fixtures.ts";
import type { TimedEvent } from "../harness/globals";
import type { GapAnalysis } from "../src/testing/gap-analysis";

type Profile = "fmp4-flac" | "fmp4-aac";

const events = (page: Page): Promise<ReadonlyArray<TimedEvent>> =>
  page.evaluate(() => [...(window.harness?.events ?? [])]);

const ofType = async (page: Page, type: TimedEvent["type"]): Promise<ReadonlyArray<TimedEvent>> =>
  (await events(page)).filter((event) => event.type === type);

const waitForEvent = (page: Page, type: TimedEvent["type"], count = 1, timeout = 30_000) =>
  expect
    .poll(async () => (await ofType(page, type)).length, { timeout })
    .toBeGreaterThanOrEqual(count);

const lastPosition = async (page: Page): Promise<number> => {
  const last = (await ofType(page, "time")).at(-1);

  return last?.type === "time" ? last.positionMs : -1;
};

const keysOf = (list: ReadonlyArray<TimedEvent>): ReadonlyArray<string> =>
  list.map((event) => (event.type === "advanced" ? event.key : ""));

const media = `http://127.0.0.1:${mediaPort}`;

/** Makes the stub forget its transcodes: every song's next request is a live first play. */
const coldCache = async (request: APIRequestContext): Promise<void> => {
  expect((await request.post(`${media}/control/cold`)).ok()).toBe(true);
};

/** Fetches each song in full, so the next requests are served from finished transcodes. */
const warmCache = (request: APIRequestContext, files: ReadonlyArray<string>) =>
  Promise.all(
    files.map(async (file) => {
      const response = await request.get(`${media}/fixtures/${file}`);

      expect(response.ok()).toBe(true);
      await response.body();
    }),
  );

const open = async (page: Page, engine: "mse" | "html"): Promise<void> => {
  await page.goto(`/engine.html?media=${mediaPort}&engine=${engine}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  // A real click: WebKit keeps the AudioContext suspended until a user gesture.
  await page.locator("body").click();
};

/** Plays three parts back to back (preloading each next one) and analyzes the recording. */
const playSequence = async (page: Page, files: ReadonlyArray<string>): Promise<GapAnalysis> => {
  const [first = "", second = "", third = ""] = files;

  await page.evaluate(
    async ([one, two]) => {
      window.harness?.preload(two);
      window.harness?.record();
      await window.harness?.load(one, 0, true);
    },
    [first, second] as const,
  );

  await waitForEvent(page, "advanced", 1);
  await page.evaluate((three) => {
    window.harness?.preload(three);
  }, third);
  await waitForEvent(page, "advanced", 2);
  await waitForEvent(page, "ended", 1);

  const analysis = await page.evaluate(
    ([cuts, frequency, rate]) => window.harness?.analyze(cuts, frequency, rate),
    [GAPLESS_CUTS, GAPLESS_FREQUENCY, GAPLESS_RATE] as const,
  );

  if (analysis === undefined) throw new Error("The harness did not analyze the recording");

  return analysis;
};

const report = (label: string, analysis: GapAnalysis): void => {
  const boundaries = analysis.boundaries
    .map(
      (boundary, index) =>
        `boundary ${index + 1}: ${boundary.offsetSamples.toFixed(2)} samples, ` +
        `residual ${boundary.residual.toExponential(1)}`,
    )
    .join("; ");

  const line =
    `${label}: ${analysis.sampleError.toFixed(2)} samples off in total at ${analysis.sampleRate} Hz, ` +
    `longest silence ${analysis.longestSilence}, noise floor ${analysis.noiseFloor.toExponential(1)}; ${boundaries}`;

  console.log(line);
  test.info().annotations.push({ type: "gap", description: line });
};

const supportsChangeType = (page: Page): Promise<boolean> =>
  page.evaluate(() => "SourceBuffer" in window && "changeType" in SourceBuffer.prototype);

/** Longest a seek far ahead of a running transcode may take to play. */
const SEEK_AHEAD_LIMIT_MS = 1500;

/** Largest boundary offset and total length error, in samples, that still count as gapless. */
const TOLERANCE_SAMPLES = 2;

/**
 * Playwright's WebKit on Linux (WPE with GStreamer) loses audio between a media element and Web
 * Audio: even HTML audio on the original files records seconds short. The recording cannot measure
 * a gap there, so the gap tests are expected to fail; Safari itself is not covered.
 */
const LOSSY_CAPTURE = "WebKit on Linux drops audio between the media element and Web Audio";

const sequences: ReadonlyArray<{
  readonly name: string;
  readonly parts: ReadonlyArray<readonly [GaplessSource, Profile]>;
}> = [
  {
    name: "FLAC sources remuxed to fmp4-flac",
    parts: [
      ["flac", "fmp4-flac"],
      ["flac", "fmp4-flac"],
      ["flac", "fmp4-flac"],
    ],
  },
  {
    name: "FLAC sources encoded to fmp4-aac",
    parts: [
      ["flac", "fmp4-aac"],
      ["flac", "fmp4-aac"],
      ["flac", "fmp4-aac"],
    ],
  },
  {
    name: "MP3 sources encoded to fmp4-aac",
    parts: [
      ["mp3", "fmp4-aac"],
      ["mp3", "fmp4-aac"],
      ["mp3", "fmp4-aac"],
    ],
  },
  {
    name: "AAC sources encoded to fmp4-aac",
    parts: [
      ["m4a", "fmp4-aac"],
      ["m4a", "fmp4-aac"],
      ["m4a", "fmp4-aac"],
    ],
  },
];

const fileFor = ([source, profile]: readonly [GaplessSource, Profile], part: number): string =>
  `${gaplessFile(source, part)}?p=${profile}`;

/**
 * Each sequence plays as a first play, streamed while the media service transcodes it (estimated
 * length, held-back end, exact timing fetched at the end), and again from finished transcodes.
 */
const deliveries = ["first play", "cached"] as const;

test.describe("gapless playback", () => {
  for (const sequence of sequences) {
    for (const delivery of deliveries) {
      const name = `${sequence.name} (${delivery})`;

      test(name, async ({ page, request, browserName }) => {
        test.fail(browserName === "webkit", LOSSY_CAPTURE);
        const files = sequence.parts.map((part, index) => fileFor(part, index + 1));

        if (delivery === "first play") await coldCache(request);
        else await warmCache(request, files);
        const exactTimings: Array<string> = [];

        page.on("request", (sent) => {
          if (sent.method() === "HEAD") exactTimings.push(sent.url());
        });

        await open(page, "mse");
        const analysis = await playSequence(page, files);

        report(name, analysis);
        // A first play streams each song live and asks for its exact length at the end.
        expect(exactTimings).toHaveLength(delivery === "first play" ? files.length : 0);
        expect(await ofType(page, "error")).toEqual([]);
        expect(keysOf(await ofType(page, "advanced"))).toEqual(files.slice(1));
        expect(await ofType(page, "ended")).toHaveLength(1);
        expect(Math.abs(analysis.sampleError)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);
        expect(analysis.longestSilence).toBeLessThanOrEqual(1);

        for (const boundary of analysis.boundaries) {
          expect(Math.abs(boundary.offsetSamples)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);
        }

        // Lossless joins are clean to the noise floor; AAC adds a coding transient at each cut,
        // which ffmpeg's own decode of the same files shows too.
        if (sequence.parts.every(([, profile]) => profile === "fmp4-flac")) {
          for (const boundary of analysis.boundaries) {
            expect(boundary.residual).toBeLessThanOrEqual(analysis.noiseFloor * 4);
          }
        }
      });
    }
  }

  test("switches between FLAC and AAC mid-queue", async ({ page }) => {
    await open(page, "mse");

    const files = [
      fileFor(["flac", "fmp4-flac"], 1),
      fileFor(["mp3", "fmp4-aac"], 2),
      fileFor(["flac", "fmp4-flac"], 3),
    ];

    const analysis = await playSequence(page, files);
    const changeType = await supportsChangeType(page);

    report(`codec switch (changeType ${changeType ? "supported" : "missing"})`, analysis);
    expect(await ofType(page, "error")).toEqual([]);
    expect(keysOf(await ofType(page, "advanced"))).toEqual(files.slice(1));

    // Without changeType the engine resets the MediaSource at each switch: it plays on, with a gap.
    if (changeType) {
      expect(Math.abs(analysis.sampleError)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);

      for (const boundary of analysis.boundaries) {
        expect(Math.abs(boundary.offsetSamples)).toBeLessThanOrEqual(TOLERANCE_SAMPLES);
      }
    }
  });

  test("baseline: HTML audio on the original FLAC files", async ({ page }) => {
    await open(page, "html");
    const files = [1, 2, 3].map((part) => gaplessFile("flac", part));
    const analysis = await playSequence(page, files);

    report("HTML audio baseline", analysis);
    expect(keysOf(await ofType(page, "advanced"))).toEqual(files.slice(1));
  });
});

test.describe("MseEngine", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "mse");
  });

  test("starts at a position, then seeks inside and far outside the buffer", async ({
    page,
    browserName,
  }) => {
    const song = "song-1.flac?p=fmp4-flac";

    await page.evaluate((file) => window.harness?.load(file, 45_000, false), song);
    await waitForEvent(page, "paused");
    expect(await lastPosition(page)).toBe(45_000);

    await page.evaluate(() => window.harness?.engine.play());
    await waitForEvent(page, "playing");
    await page.waitForTimeout(600);
    expect(await lastPosition(page)).toBeGreaterThan(45_000);

    // Behind the start position: never downloaded, so the engine refetches from that fragment.
    await page.evaluate(() => {
      window.harness?.resetGap();
      window.harness?.engine.seek(5000);
    });

    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(5200);
    expect(await lastPosition(page)).toBeLessThan(9000);

    // Ahead by more than the buffer: another range request.
    await page.evaluate(() => {
      window.harness?.engine.seek(80_000);
    });

    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(80_200);

    // Inside what is buffered: just moves the playhead.
    await page.evaluate(() => {
      window.harness?.engine.seek(80_500);
    });

    await page.waitForTimeout(500);
    expect(await lastPosition(page)).toBeGreaterThan(80_500);
    expect(await ofType(page, "error")).toEqual([]);

    // Sound reached the speakers after the seeks (WebKit's recording path loses audio; see above).
    if (browserName !== "webkit") {
      const gap = await page.evaluate(() => window.harness?.gap());

      expect(gap?.soundMs ?? 0).toBeGreaterThan(1000);
    }
  });

  test("seeks behind and ahead of a song that is still being transcoded", async ({
    page,
    request,
  }) => {
    // Ninety seconds of MP3 to AAC: the transcode runs for about a second.
    const song = "song-2.mp3?p=fmp4-aac";

    const live: Array<boolean> = [];

    page.on("response", (response) => {
      if (response.request().method() === "GET" && response.url().includes("song-2.mp3")) {
        live.push(response.headers()["x-music-duration-estimated"] === "1");
      }
    });

    await coldCache(request);
    // Past the engine's 30-second look-ahead, with no index to jump there.
    await page.evaluate((file) => window.harness?.load(file, 45_000, true), song);
    await waitForEvent(page, "playing");
    expect(live[0]).toBe(true);
    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(45_200);

    // Behind the start: the song is fetched again from the start (live or finished).
    await page.evaluate(() => {
      window.harness?.engine.seek(5000);
    });

    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(5200);
    expect(await lastPosition(page)).toBeLessThan(9000);

    // Far ahead, into what the first stream may not have reached.
    await page.evaluate(() => {
      window.harness?.engine.seek(80_000);
    });

    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(80_200);
    expect(await ofType(page, "error")).toEqual([]);
    await waitForEvent(page, "ended", 1, 20_000);
    expect(await ofType(page, "error")).toEqual([]);
  });

  for (const delivery of ["cached", "still transcoding"] as const) {
    test(`seeks near the end of a queued song it advanced into (${delivery})`, async ({
      page,
      request,
    }) => {
      const [first, second, third] = [
        "song-1.flac?p=fmp4-flac",
        "song-2.mp3?p=fmp4-flac",
        "song-3.opus?p=fmp4-flac",
      ];

      const live: Array<boolean> = [];
      const urls: Array<string> = [];

      page.on("response", (response) => {
        if (response.request().method() === "GET" && response.url().includes("song-2.mp3")) {
          live.push(response.headers()["x-music-duration-estimated"] === "1");
          urls.push(response.url());
        }
      });

      await coldCache(request);

      if (delivery === "cached") {
        await warmCache(request, [first, second, third]);
      } else {
        // The first song comes from the cache; the second is transcoded slowly enough that the
        // seek lands far ahead of the encoder.
        await warmCache(request, [first]);
        expect((await request.post(`${media}/control/slow`)).ok()).toBe(true);
      }

      try {
        // The second song is appended behind the first on one timeline.
        await page.evaluate(
          async ([one, two]) => {
            window.harness?.preload(two);
            await window.harness?.load(one, 87_000, true);
          },
          [first, second] as const,
        );

        await waitForEvent(page, "advanced");
        await page.evaluate((three) => {
          window.harness?.preload(three);
        }, third);
        await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(1000);

        // Far past what the look-ahead appended of the second song: the media source's duration
        // still ends there.
        const seekedAt = await page.evaluate(() => {
          window.harness?.engine.seek(85_000);

          return window.harness?.events.length ?? 0;
        });

        await expect.poll(() => lastPosition(page), { timeout: 30_000 }).toBeGreaterThan(85_200);
        expect(keysOf(await ofType(page, "advanced"))).toEqual([second]);
        expect(live.at(-1)).toBe(delivery === "still transcoding");
        // Ahead of the encoder the song streams from the target; a finished file is jumped in.
        expect(urls.at(-1)?.includes("start=85000")).toBe(delivery === "still transcoding");

        // Every position reported for the second song since the seek is at or past the target.
        await waitForEvent(page, "advanced", 2);
        const since = (await events(page)).slice(seekedAt);
        const advance = since.findIndex((event) => event.type === "advanced");

        const positions = since
          .slice(0, advance)
          .flatMap((event) => (event.type === "time" ? [event.positionMs] : []));

        expect(Math.min(...positions)).toBeGreaterThanOrEqual(85_000);
        expect(keysOf(await ofType(page, "advanced"))).toEqual([second, third]);
        expect(await ofType(page, "ended")).toEqual([]);
        expect(await ofType(page, "error")).toEqual([]);
      } finally {
        expect((await request.post(`${media}/control/fast`)).ok()).toBe(true);
      }
    });
  }

  for (const song of ["song-2.mp3?p=fmp4-aac", "song-1.flac?p=fmp4-flac"]) {
    test(`seeks far ahead of a transcode at once (${song})`, async ({ page, request }) => {
      const offsets: Array<string> = [];

      page.on("request", (sent) => {
        if (sent.url().includes("start=")) offsets.push(sent.url());
      });

      await coldCache(request);
      // The full transcode runs at eight times real time, so the target stays far ahead of it.
      expect((await request.post(`${media}/control/slow`)).ok()).toBe(true);

      try {
        await page.evaluate((file) => window.harness?.load(file, 0, true), song);
        await waitForEvent(page, "playing");
        await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(500);

        const seekedAt = await page.evaluate(() => {
          window.harness?.engine.seek(80_000);

          return performance.now();
        });

        // Playing again: the first position reported past the target (an upper bound, by up to one
        // tick of the position updates).
        await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(80_000);

        const resumed = (await ofType(page, "time")).find(
          (event) => event.at > seekedAt && event.type === "time" && event.positionMs > 80_000,
        );

        const resumeMs = (resumed?.at ?? Number.NaN) - seekedAt;

        console.log(`${song} seek ahead of the transcode: playing after ${resumeMs.toFixed(0)} ms`);
        test.info().annotations.push({ type: "seek-ahead-ms", description: resumeMs.toFixed(0) });
        expect(resumeMs).toBeLessThan(SEEK_AHEAD_LIMIT_MS);
        expect(offsets).toHaveLength(1);
        expect(offsets[0]).toContain("start=80000");

        // It plays out the rest, cut at the exact end the finished transcode reports.
        await waitForEvent(page, "ended", 1, 20_000);
        expect(await lastPosition(page)).toBeGreaterThan(89_000);
        expect(await ofType(page, "error")).toEqual([]);
      } finally {
        expect((await request.post(`${media}/control/fast`)).ok()).toBe(true);
      }
    });
  }

  for (const profile of ["fmp4-flac", "fmp4-aac"] as const) {
    for (const queued of [false, true]) {
      test(`ends a song on a seek past its real end, short of its estimate (${profile}${queued ? ", then the next" : ""})`, async ({
        page,
        request,
      }) => {
        const song = `${TRUNCATED_FIXTURE}?p=${profile}`;
        const next = `tone-d.mp3?p=${profile}`;
        const offsets: Array<string> = [];

        page.on("request", (sent) => {
          if (sent.url().includes("start=")) offsets.push(sent.url());
        });

        await coldCache(request);
        await page.evaluate(
          ([file, duration, then]) => {
            if (then !== null) window.harness?.preload(then);

            return window.harness?.load(file, 0, true, duration);
          },
          [song, TRUNCATED_DECLARED_MS, queued ? next : null] as const,
        );
        await waitForEvent(page, "playing");
        await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(500);

        // Between the real end and the estimate, and past the look-ahead: an offset stream, which
        // brings an init segment (for AAC, with padding) but none of the song.
        const target = (TRUNCATED_REAL_MS + TRUNCATED_DECLARED_MS) / 2;

        await page.evaluate((position) => {
          window.harness?.engine.seek(position);
        }, target);

        if (queued) {
          await waitForEvent(page, "advanced", 1, 20_000);
          expect(keysOf(await ofType(page, "advanced"))).toEqual([next]);
        }

        await waitForEvent(page, "ended", 1, 20_000);
        expect(offsets).toEqual([expect.stringContaining(`start=${target}`)]);
        expect(await ofType(page, "error")).toEqual([]);

        // The song ends at its real end, not at the estimate the seek was clamped to, and once.
        if (!queued) {
          expect(Math.abs((await lastPosition(page)) - TRUNCATED_REAL_MS)).toBeLessThan(1000);
        }

        await page.waitForTimeout(1000);
        expect(await ofType(page, "ended")).toHaveLength(1);
      });
    }
  }

  test("seeks once a media service busy with other seeks has room", async ({ page, request }) => {
    const song = "song-2.mp3?p=fmp4-aac";
    const statuses: Array<number> = [];

    page.on("response", (response) => {
      if (response.url().includes("start=") && response.status() !== 0) {
        statuses.push(response.status());
      }
    });

    await coldCache(request);
    // The full transcode runs at eight times real time, so the target stays far ahead of it.
    expect((await request.post(`${media}/control/slow`)).ok()).toBe(true);

    try {
      await page.evaluate((file) => window.harness?.load(file, 0, true), song);
      await waitForEvent(page, "playing");
      await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(500);

      // Every seek transcode is taken for a moment: the seek's stream answers 503, Retry-After: 1.
      expect((await request.post(`${media}/control/busy?ms=1500`)).ok()).toBe(true);
      await page.evaluate(() => {
        window.harness?.engine.seek(80_000);
      });

      await expect.poll(() => lastPosition(page), { timeout: 20_000 }).toBeGreaterThan(80_200);
      expect(await lastPosition(page)).toBeLessThan(85_000);
      expect(statuses[0]).toBe(503);
      expect(statuses.at(-1)).toBe(200);
      expect(await ofType(page, "error")).toEqual([]);
    } finally {
      expect((await request.post(`${media}/control/fast`)).ok()).toBe(true);
    }
  });

  for (const mode of ["abort", "end", "hang"] as const) {
    test(`picks up a live stream cut off mid-song (${mode})`, async ({ page, request }) => {
      const song = "song-2.mp3?p=fmp4-aac";
      const offsets: Array<string> = [];

      page.on("request", (sent) => {
        if (sent.url().includes("start=")) offsets.push(sent.url());
      });

      await coldCache(request);
      // About eight seconds of AAC at 256 kbps, then the stream stops short of the 90 s song.
      const cut = await request.post(`${media}/control/cut?bytes=256000&mode=${mode}`);

      expect(cut.ok()).toBe(true);
      await page.evaluate((file) => window.harness?.load(file, 0, true), song);
      await waitForEvent(page, "playing");

      // It plays on past the cut from where the appends stopped, without skipping the song.
      await expect.poll(() => lastPosition(page), { timeout: 30_000 }).toBeGreaterThan(15_000);
      expect(offsets.length).toBeGreaterThan(0);
      expect(await ofType(page, "ended")).toEqual([]);
      expect(await ofType(page, "error")).toEqual([]);
    });
  }

  test("keeps playing a hi-res stream larger than the buffer quota", async ({ page }) => {
    await page.evaluate(
      (file) => window.harness?.load(file, 0, true),
      `${HIRES_FIXTURE}?p=fmp4-flac`,
    );
    await waitForEvent(page, "playing");
    const started = (await ofType(page, "waiting")).length;

    // Long enough for the look-ahead to fill the quota (Firefox stops near 14 MB, ~24 s ahead).
    await expect.poll(() => lastPosition(page), { timeout: 20_000 }).toBeGreaterThan(12_000);
    expect((await ofType(page, "waiting")).length).toBe(started);

    await page.evaluate(() => {
      window.harness?.engine.seek(50_000);
    });

    await expect.poll(() => lastPosition(page), { timeout: 10_000 }).toBeGreaterThan(51_000);
    expect(await ofType(page, "error")).toEqual([]);
  });

  test("ends without advancing when the preload is cleared", async ({ page }) => {
    await page.evaluate(async () => {
      window.harness?.preload("gapless-flac-3.flac?p=fmp4-flac");
      await window.harness?.load("gapless-flac-2.flac?p=fmp4-flac", 1500, true);
    });

    await waitForEvent(page, "playing");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.harness?.preload(null);
    });

    await waitForEvent(page, "ended");
    expect(await ofType(page, "advanced")).toEqual([]);
    expect(await ofType(page, "error")).toEqual([]);
  });

  test("replaces a queued song with another", async ({ page }) => {
    await page.evaluate(async () => {
      window.harness?.preload("gapless-flac-3.flac?p=fmp4-flac");
      await window.harness?.load("gapless-flac-2.flac?p=fmp4-flac", 1000, true);
    });

    await waitForEvent(page, "playing");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.harness?.preload("gapless-flac-1.flac?p=fmp4-flac");
    });

    await waitForEvent(page, "advanced");
    expect(keysOf(await ofType(page, "advanced"))).toEqual(["gapless-flac-1.flac?p=fmp4-flac"]);
    expect(await ofType(page, "error")).toEqual([]);
  });

  test("skips into the queued song without refetching it", async ({ page }) => {
    await page.evaluate(async () => {
      window.harness?.preload("gapless-flac-2.flac?p=fmp4-flac");
      await window.harness?.load("gapless-flac-1.flac?p=fmp4-flac", 0, true);
    });

    await waitForEvent(page, "playing");
    await page.waitForTimeout(800);
    await page.evaluate(() => window.harness?.load("gapless-flac-2.flac?p=fmp4-flac", 0, true));
    await page.waitForTimeout(500);

    const position = await lastPosition(page);

    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThan(1500);
    // Playing out the rest of song 2 ends the queue.
    await waitForEvent(page, "ended");
    expect(await ofType(page, "error")).toEqual([]);
  });

  test("reports an error for a missing file without hanging the load", async ({ page }) => {
    await page.evaluate(() => window.harness?.load("missing.flac?p=fmp4-flac", 0, true));
    const errors = await ofType(page, "error");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.type === "error" ? errors[0].reason : null).toBe("unsupported");
  });

  test("unload stops the output", async ({ page }) => {
    await page.evaluate(() => window.harness?.load("gapless-flac-1.flac?p=fmp4-flac", 0, true));
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
});
