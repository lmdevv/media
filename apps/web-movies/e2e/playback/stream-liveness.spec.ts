import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { createLibrary, removeLibrary, titlesByName } from "../stack/libraries";
import type { LibraryId, TitleId } from "../stack/libraries";
import { loggedAbout } from "../stack/media-logs";
import { buildMediaService, startMediaService, writeFakeFfmpeg } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
} from "../stack/people";
import type { Client } from "../stack/people";
import { recordStreams } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";
import {
  encodeClip,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 180_000;

const TEST_TIMEOUT_MS = 120_000;

const STREAM_IDLE_SECONDS = 5;

const PAUSE_MS = 15_000;

const BUFFERED_AHEAD_SECONDS = 20;

const MOVIE = "Harbor Night Watch";

const HEVC_MOVIE = "Tidewater Relay";

const run = Date.now().toString(36);

interface HlsResponse {
  readonly streamId: string;
  readonly generation: number;
  readonly file: string;
  readonly status: number;
  readonly at: number;
}

const HLS_FILE = /\/media\/hls\/(?<streamId>[^/]+)\/(?<generation>\d+)\/(?<file>[^/?]+)/u;

const recordHls = (page: Page): ReadonlyArray<HlsResponse> => {
  const responses: Array<HlsResponse> = [];

  page.on("response", (response) => {
    const groups = HLS_FILE.exec(new URL(response.url()).pathname)?.groups;

    if (groups?.["streamId"] === undefined || groups["file"] === undefined) return;

    responses.push({
      streamId: groups["streamId"],
      generation: Number(groups["generation"]),
      file: groups["file"],
      status: response.status(),
      at: Date.now(),
    });
  });

  return responses;
};

const isSegment = (response: HlsResponse): boolean => response.file.endsWith(".m4s");

const bufferedAhead = (page: Page): Promise<number> =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    const ranges = Array.from({ length: element.buffered.length }, (_, index) => ({
      start: element.buffered.start(index),
      end: element.buffered.end(index),
    }));

    const current = ranges.find(
      (range) => range.start <= element.currentTime && element.currentTime <= range.end,
    );

    return current === undefined ? 0 : current.end - element.currentTime;
  });

let workspace = "";

let fakeFfmpeg = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

let hls: ReadonlyArray<HlsResponse> = [];

let titleId: TitleId;

let libraryId: LibraryId | undefined;

let hevcTitleId: TitleId;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-liveness-");

  const films = join(workspace, "Films");
  const folder = join(films, `${MOVIE} (2022)`);
  const hevcFolder = join(films, `${HEVC_MOVIE} (2023)`);

  await Promise.all([
    encodeClip(join(folder, `${MOVIE} (2022).mkv`), {
      seconds: 120,
      video: "h264",
      audio: [{ codec: "ac3", language: "eng" }],
    }),
    writeText(join(folder, "movie.nfo"), movieNfo(MOVIE, 2022)),
    encodeClip(join(hevcFolder, `${HEVC_MOVIE} (2023).mkv`), {
      seconds: 120,
      video: "hevc",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(hevcFolder, "movie.nfo"), movieNfo(HEVC_MOVIE, 2023)),
  ]);

  fakeFfmpeg = writeFakeFfmpeg({ qsvFailsFromSeconds: 1 });

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace], {
    STREAM_IDLE_SECONDS: String(STREAM_IDLE_SECONDS),
  });
  owner = await signInClient(stack, await createPerson(stack, "admin"));
  libraryId = await createLibrary(owner.platform, {
    name: `Liveness films ${run}`,
    folders: [films],
  });

  const titles = await titlesByName(owner.platform, libraryId);
  const scanned = titles.get(MOVIE);
  const hevc = titles.get(HEVC_MOVIE);

  if (scanned === undefined || hevc === undefined) throw new Error("A film was not scanned");

  titleId = scanned;
  hevcTitleId = hevc;
  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  hls = recordHls(page);
  await signIn(page, owner.person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await removeLibrary(owner.platform, libraryId);
  await owner.platform.dispose();
  await media?.stop();
  await removePath(workspace);

  if (fakeFfmpeg !== "") await removePath(dirname(fakeFfmpeg));
});

test("a paused viewer resumes on the same stream after the media service's idle time", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  await page.goto(moviesPath(`/watch/${titleId}?start=0`));
  await expectPlayingPast(page, 1);
  await expect.poll(() => streams.at(-1)?.mode).toBe("audio-transcode");

  const streamId = streams.at(-1)?.streamId;

  if (streamId === undefined) throw new Error("The audio transcode has no stream id");

  await expect
    .poll(() => bufferedAhead(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(BUFFERED_AHEAD_SECONDS);
  expect(hls.filter(isSegment).map((response) => response.streamId)).toContain(streamId);

  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const pausedAt = Date.now();
  const pausedPosition = (await videoState(page)).currentTime;

  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

  const resumedAt = Date.now();

  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  await expect
    .poll(() => hls.filter((response) => response.at >= resumedAt && isSegment(response)).length, {
      message: "the resumed player fetches segments past its buffer",
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(3);

  const afterPause = hls.filter((response) => response.at >= pausedAt);

  expect(
    afterPause
      .filter((response) => response.status !== 200 || response.streamId !== streamId)
      .map(
        ({ streamId: id, generation, file, status }) =>
          `${String(status)} ${id}/${String(generation)}/${file}`,
      ),
    `every HLS answer after the pause is a 200 on stream ${streamId}`,
  ).toEqual([]);
  expect(
    streams.map((stream) => stream.streamId),
    "the player negotiated no other stream",
  ).toEqual([streamId]);
  await expectPlayingPast(page, pausedPosition + 10, 30_000);

  const generation = hls.findLast(
    (response) => response.streamId === streamId && response.at < pausedAt,
  )?.generation;

  expect(
    loggedAbout(media, "Stream.released", streamId).map(({ annotations }) => ({
      liveness: annotations["liveness"],
      generation: annotations["generation"],
    })),
    "the paused stream's encoder stopped once, the core reporting no positions",
  ).toEqual([{ liveness: "unknown", generation }]);
  expect(
    loggedAbout(media, "Stream.resumed", streamId).map(
      ({ annotations }) => annotations["generation"],
    ),
    "and restarted once, in the generation the player holds",
  ).toEqual([generation]);
});

test("a Quick Sync stream that cannot restart after a pause reloads into software on the same stream", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  if (stack === null) return;

  await page.close();
  await media?.stop();

  media = await startMediaService(offline(stack), [workspace], {
    STREAM_IDLE_SECONDS: String(STREAM_IDLE_SECONDS),
    HARDWARE_ACCELERATION: "qsv",
    FFMPEG_PATH: fakeFfmpeg,
  });
  page = await context.newPage();
  streams = recordStreams(page);
  hls = recordHls(page);

  await page.goto(moviesPath(`/watch/${hevcTitleId}?start=0`));
  await expectPlayingPast(page, 1);
  await expect.poll(() => streams.at(-1)?.mode).toBe("transcode-qsv");

  const streamId = streams.at(-1)?.streamId;

  if (streamId === undefined) throw new Error("The Quick Sync transcode has no stream id");

  await expect
    .poll(() => bufferedAhead(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(BUFFERED_AHEAD_SECONDS);

  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const pausedPosition = (await videoState(page)).currentTime;

  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

  expect(
    loggedAbout(media, "Stream.released", streamId).map(
      ({ annotations }) => annotations["liveness"],
    ),
    "the paused stream's encoder stopped",
  ).toEqual(["unknown"]);

  const resumedAt = Date.now();

  await page.getByTestId("player").press("k");

  const afterResume = () =>
    hls.filter((response) => response.at >= resumedAt && response.streamId === streamId);

  await expect
    .poll(
      () =>
        afterResume()
          .filter((response) => response.status !== 200)
          .map(({ generation, file, status }) => `${String(status)} ${String(generation)}/${file}`),
      {
        message: "the restarted encoder failed, so its segment's generation is gone",
        timeout: 45_000,
      },
    )
    .toEqual([expect.stringMatching(/^410 1\/\d+\.m4s$/u)]);
  await expect
    .poll(
      () =>
        afterResume().filter(
          (response) => response.generation > 1 && isSegment(response) && response.status === 200,
        ).length,
      { message: "the player reloaded a later generation of the same stream", timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expectPlayingPast(page, pausedPosition + 10, 30_000);
  expect(
    streams.map((stream) => stream.streamId),
    "the player negotiated no other stream",
  ).toEqual([streamId]);
  expect(
    loggedAbout(media, "Stream.mode_changed", streamId).map(({ annotations }) => [
      annotations["from"],
      annotations["to"],
    ]),
    "the failed restart fell back to software",
  ).toEqual([["transcode-qsv", "transcode-software"]]);
});
