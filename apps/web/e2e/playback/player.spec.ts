import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceId } from "@media/contracts/ids";
import type { EpisodeId, TitleId } from "@media/contracts/ids";
import { MEDIA_ROUTES } from "@media/contracts/media-playback";
import type { PlaybackMode } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { formatTimecode } from "@media/ui/lib/timecode";
import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request, Route } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { drawStill } from "../stack/fixture-library";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  HAVE_CURRENT_DATA,
  adultProfile,
  capture,
  clickScrubber,
  commandMenu,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  expectPositionNear,
  firstFrameMs,
  holdKey,
  holdSegments,
  leaveDialog,
  leaveWithEscape,
  movieNfo,
  offline,
  revealControls,
  scanLibrary,
  showNfo,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";
import { recordStreams, refuseQualityCaps } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const SRT = `1
00:00:00,500 --> 00:01:00,000
The lighthouse keeper climbs the stairs.

2
00:01:00,500 --> 00:02:00,000
The lamp turns all night.
`;

const MOVIES = {
  direct: "Lighthouse Keeper",
  remux: "Signal Box",
  audio: "Night Ferry",
  transcode: "Glass Harbor",
  missing: "Lost Reel",
  pictures: "Paper Lantern",
} as const;

const VOBSUB = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "media",
  "src",
  "testing",
  "fixtures",
  "vobsub.mkv",
);

const TRACKS = "Audio, subtitles, and quality";

const SHOW = "Tide Tables";

const EPISODES = ["Low Water", "Slack Tide", "Spring Tide"] as const;

const SLACK_TIDE = {
  plot: "The harbor master's daughter comes home to the lighthouse; the ferry crew argues over the night timetable; the keeper's log goes missing.",
  runtimeMinutes: 48,
} as const;

const SEASON_TWO = ["Neap Tide"] as const;

const EPISODE_SECONDS = 30;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

const titles = new Map<string, TitleId>();

const episodes: Array<EpisodeId> = [];

const seasonTwo: Array<EpisodeId> = [];

const firstFrames: Array<{ readonly mode: string; readonly ms: number }> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-player-"));

  const films = join(workspace, "Films");
  const shows = join(workspace, "Shows");
  const folder = (name: string): string => join(films, `${name} (2021)`);

  const showFolder = join(shows, `${SHOW} (2020)`, "Season 01");

  await Promise.all([
    encodeClip(join(folder(MOVIES.direct), `${MOVIES.direct} (2021).mp4`), {
      seconds: 120,
      video: "h264",
      audio: [
        { codec: "aac", language: "eng" },
        { codec: "aac", language: "fra" },
      ],
    }),
    writeText(join(folder(MOVIES.direct), `${MOVIES.direct} (2021).en.srt`), SRT),
    encodeClip(join(folder(MOVIES.remux), `${MOVIES.remux} (2021).ts`), {
      seconds: 120,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(folder(MOVIES.audio), `${MOVIES.audio} (2021).mkv`), {
      seconds: 60,
      video: "h264",
      audio: [{ codec: "ac3", language: "eng" }],
    }),
    encodeClip(join(folder(MOVIES.transcode), `${MOVIES.transcode} (2021).mkv`), {
      seconds: 120,
      video: "hevc",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(folder(MOVIES.pictures), `${MOVIES.pictures} (2021).mkv`), {
      seconds: 30,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
      subtitles: { file: VOBSUB, language: "eng" },
    }),
    encodeClip(join(folder(MOVIES.missing), `${MOVIES.missing} (2021).mp4`), {
      seconds: 10,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    ...Object.values(MOVIES).map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2021)),
    ),
    writeText(join(shows, `${SHOW} (2020)`, "tvshow.nfo"), showNfo(SHOW, 2020)),
    ...EPISODES.flatMap((name, index) => {
      const stem = join(showFolder, `${SHOW} - S01E0${String(index + 1)}`);

      const second = name === EPISODES[1];

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(1, index + 1, name, second ? SLACK_TIDE : {})),
        ...(second ? [drawStill(browser, name, `${stem}-thumb.jpg`)] : []),
      ];
    }),
    ...SEASON_TWO.flatMap((name, index) => {
      const stem = join(
        shows,
        `${SHOW} (2020)`,
        "Season 02",
        `${SHOW} - S02E0${String(index + 1)}`,
      );

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(2, index + 1, name)),
      ];
    }),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const filmsId = await scanLibrary(owner.sdk, {
    name: `Playback films ${run}`,
    kind: "movies",
    root: films,
    access: "everyone",
  });

  const showsId = await scanLibrary(owner.sdk, {
    name: `Playback shows ${run}`,
    kind: "shows",
    root: shows,
    access: "everyone",
  });

  const scanned = await Promise.all([filmsId, showsId].map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

  const profile = await adultProfile(owner.sdk);

  const season = await owner.sdk.query("titles.episodes", {
    profileId: profile.id,
    titleId: titleId(SHOW),
    seasonNumber: 1,
  });

  episodes.push(...season.map((episode) => episode.id));

  const second = await owner.sdk.query("titles.episodes", {
    profileId: profile.id,
    titleId: titleId(SHOW),
    seasonNumber: 2,
  });

  seasonTwo.push(...second.map((episode) => episode.id));
  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  await useSession(page, owner);
});

test.afterAll(async () => {
  if (stack === null) return;

  test.info().annotations.push({
    type: "first-frame",
    description: firstFrames.map(({ mode, ms }) => `${mode} ${String(ms)} ms`).join(", "),
  });

  console.log(`First frame by mode: ${JSON.stringify(firstFrames)}`);
  await context.close();
  await owner.sdk.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

function titleId(name: string): TitleId {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
}

const playFromStart = async (name: string, mode: PlaybackMode): Promise<void> => {
  const before = streams.length;

  await page.goto(`/watch/${titleId(name)}?start=0`);
  await expectPlayingPast(page, 0.5);
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe(mode);
  firstFrames.push({ mode, ms: await firstFrameMs(page) });
};

const showingSubtitle = () =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return null;

    const track = Array.from(element.textTracks).find((each) => each.mode === "showing");

    return track === undefined ? null : { label: track.label, cues: track.cues?.length ?? 0 };
  });

const CONGESTED_SEGMENT_DELAY_MS = 4_000;

const HLS_PLAYLIST = /\/media\/hls\/([^/]+)\/\d+\/index\.m3u8/u;

const HLS_SEGMENT = /\/media\/hls\/([^/]+)\/\d+\/(\d+)\.m4s/u;

const PROBE_RESUME_MS = Milliseconds.make(10_500);

/**
 * How far short of a start segment's buffered end the stream resumes. Chrome finds the frame
 * there but can't finish the seek without the next segment, which is where a pause lost it.
 */
const EDGE_MARGIN_MS = 25;

/** How far short of its buffered end a stalled element may stop: about two frames at 12 fps. */
const STALLED_SHORT_OF_EDGE_SECONDS = 0.2;

const EDGE_WINDOW_SECONDS = 0.05;

/**
 * How long the page stays busy once the held segment is buffered, before it pauses. Chrome
 * finishes the seek about 15 ms after the append unloaded, so it lands before the pause event
 * dispatches, with room for a loaded runner.
 */
const BUSY_MAIN_THREAD_MS = 250;

interface PlannedSegment {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

const segmentHolding = (playlist: string, seconds: number): PlannedSegment | undefined => {
  const durations = playlist
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => Number.parseFloat(line.slice("#EXTINF:".length)));

  let start = 0;

  for (const [index, duration] of durations.entries()) {
    const end = start + duration;

    if (seconds < end) return { index, start, end };
    start = end;
  }

  return undefined;
};

const bufferedEnd = (target: Page, seconds: number) =>
  target.getByTestId("player-video").evaluate((element, at) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    const ranges = Array.from({ length: element.buffered.length }, (_, index) => ({
      start: element.buffered.start(index),
      end: element.buffered.end(index),
    }));

    return ranges.find((range) => range.start <= at && at < range.end)?.end ?? null;
  }, seconds);

const SEEK_FRACTION = 0.8;

const PAST_THE_HELD_SEGMENTS_SECONDS = 100;

const DRIFT_SAMPLED_PAST_SECONDS = 12;

const latestWebTimeline = async (measuredDrift = false) => {
  const [session] = await owner.sdk.media("diagnostics.sessions", {});

  if (session === undefined || session.platform !== "web") return null;

  return owner.sdk.media("diagnostics.playback", { sessionId: session.sessionId, measuredDrift });
};

const activeRung = (target: Page) =>
  target.getByRole("list", { name: "Playback mode" }).locator('[aria-current="true"]');

test("a direct file plays, answers the keyboard, and lands in Continue watching", async () => {
  await playFromStart(MOVIES.direct, "direct");

  const player = page.getByTestId("player");

  const at = (await videoState(page)).currentTime;

  await player.press("l");
  await expectPositionNear(page, at + 10, 1.5);
  await player.press("ArrowRight");
  await expectPositionNear(page, at + 15, 1.5);
  await player.press("j");
  await expectPositionNear(page, at + 5, 1.5);
  await player.press("ArrowLeft");
  await expectPositionNear(page, at, 1.5);

  const quick = await page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    const before = element.currentTime;

    for (const key of ["l", "l"]) window.dispatchEvent(new KeyboardEvent("keydown", { key }));

    return element.currentTime - before;
  });

  expect(quick).toBeCloseTo(20, 1);
  await player.press("j");
  await expectPositionNear(page, at + 10, 1.5);
  await player.press("j");
  await expectPositionNear(page, at, 1.5);

  await player.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await player.press(" ");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  await player.press("ArrowDown");
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.9, 2);
  await player.press("ArrowUp");
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(1, 2);
  await player.press("m");
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await player.press("m");
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);

  await revealControls(page);
  await capture(page, "07-01-playing");
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Direct");
  await page.getByRole("button", { name: "Close stream info" }).click();

  await player.press("l");
  await player.press("l");
  await expectPlayingPast(page, 21);
  await leaveWithEscape(page);
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.direct)}$`, "u"));

  await page.getByRole("link", { name: "[movies] home" }).click();

  const row = page.getByRole("region", { name: /^Continue watching/u });

  await expect(row).toContainText(MOVIES.direct);
});

test("the resume prompt resumes where the profile stopped, or starts over", async () => {
  await page.goto(`/watch/${titleId(MOVIES.direct)}`);
  await expect(page.getByRole("heading", { name: /^Welcome back, / })).toBeVisible();

  const resume = page.getByRole("button", { name: /^Resume from 0:2\d$/u });

  await expect(resume).toBeVisible();
  await capture(page, "07-04-resume-prompt");
  await resume.click();
  await expectPlayingPast(page, 20);

  await page.reload();
  await page.getByRole("button", { name: "Start from beginning" }).click();
  await expectPlayingPast(page, 0.5);
  expect((await videoState(page)).currentTime).toBeLessThan(10);
});

test("subtitles show from the track popover and toggle with c; another audio track renegotiates", async () => {
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();

  const panel = page.getByRole("dialog", { name: TRACKS });

  await panel.getByRole("radio", { name: "English" }).last().click();
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });
  await capture(page, "07-02b-subtitles");
  await page.keyboard.press("Escape");
  await page.getByTestId("player").press("c");
  await expect.poll(showingSubtitle).toBeNull();
  await page.getByTestId("player").press("c");
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });

  const before = streams.length;
  const position = (await videoState(page)).currentTime;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await capture(page, "07-02-audio-and-subtitles");
  await panel.getByRole("radio", { name: "French" }).click();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await expectPlayingPast(page, position);
  await expect(panel.getByRole("radio", { name: "French" })).toBeChecked();

  const streamId = streams.at(-1)?.streamId;

  if (streamId === undefined) throw new Error("The remux has no stream id");

  const stopped = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/playback/stop") && (request.postData() ?? "").includes(streamId),
  );

  await page.keyboard.press("Escape");
  await leaveWithEscape(page);
  await stopped;
});

test("⌘K lists the player's audio, subtitles, and quality, and switches them as the track menu does", async () => {
  await playFromStart(MOVIES.direct, "direct");

  const { menu, playback } = commandMenu(page);
  const onPlayer = new RegExp(`/watch/${titleId(MOVIES.direct)}`, "u");

  await page.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [
      /^Pause/u,
      /^Back 10 seconds/u,
      /^Forward 10 seconds/u,
      /^Subtitles/u,
      /^Audio/u,
      /^Quality/u,
      /^Stream info/u,
      /^Full screen/u,
    ].map((name) => expect(playback.getByRole("option", { name })).toBeVisible()),
  );

  await capture(page, "07-11-command-menu-playback");

  await playback.getByRole("option", { name: /^Audio/u }).click();

  const audio = menu.getByRole("listbox", { name: "Audio" });

  await expect(audio.getByRole("option")).toHaveText([/^English/u, /^French/u]);
  await expect(audio.getByRole("option", { name: /^English/u })).toBeChecked();

  const before = streams.length;

  await audio.getByRole("option", { name: /^French/u }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(
    page.getByRole("dialog", { name: TRACKS }).getByRole("radio", { name: "French" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Subtitles/u }).click();

  const subtitles = menu.getByRole("listbox", { name: "Subtitles" });

  await expect(subtitles.getByRole("option")).toHaveText(["Off", "English"]);
  await expect(subtitles.getByRole("option", { name: "Off" })).toBeChecked();
  await subtitles.getByRole("option", { name: "English" }).click();
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });

  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Quality/u }).click();
  await expect(
    menu.getByRole("listbox", { name: "Quality" }).getByRole("option", { name: "Auto" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(playback).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(onPlayer);

  await page.getByTestId("player").press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await page.keyboard.press("ControlOrMeta+k");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement?.contains(
            document.querySelector('[data-slot="command-menu"]'),
          ) ?? false,
      ),
    )
    .toBe(true);

  const search = menu.getByRole("combobox");

  await expect(search).toBeFocused();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(playback).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();

  await page.getByTestId("player").press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Pause/u }).click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  await page.getByTestId("player").press("Escape");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(onPlayer);

  await leaveWithEscape(page);
  await expect(page.getByRole("heading", { name: MOVIES.direct, level: 1 })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
  await expect(playback).toHaveCount(0);
  await expect(menu.getByRole("option", { name: /^Audio/u })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Escape asks before leaving: open layers close first, Stay plays on, Leave goes back", async () => {
  await playFromStart(MOVIES.remux, "remux");

  const player = page.getByTestId("player");
  const leave = leaveDialog(page);
  const stay = leave.getByRole("button", { name: "Stay" });
  const onPlayer = new RegExp(`/watch/${titleId(MOVIES.remux)}`, "u");
  const paused = async () => (await videoState(page)).paused;

  await player.press("Escape");
  await expect(leave).toBeVisible();
  await expect(stay).toBeFocused();
  await expect.poll(paused).toBe(true);
  await expect(leave).toHaveCSS("opacity", "1");
  await capture(page, "07-12-leave-playback");
  await page.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  await expect(player).toBeFocused();
  await expect.poll(paused).toBe(false);

  const streamInfo = page.getByRole("button", { name: "Stream info" });

  await revealControls(page);
  await streamInfo.focus();
  await page.keyboard.press("Escape");
  await expect(stay).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  await expect(streamInfo).toBeFocused();

  await player.press("Escape");
  await stay.click();
  await expect(leave).toBeHidden();
  await expect.poll(paused).toBe(false);
  await player.press("Escape");
  await expect(leave).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(leave).toBeHidden();
  await expect.poll(paused).toBe(false);

  await player.press("k");
  await expect.poll(paused).toBe(true);
  await player.press("Escape");
  await stay.click();
  await expect(leave).toBeHidden();
  await page.waitForTimeout(500);
  expect(await paused()).toBe(true);
  await player.press("k");
  await expect.poll(paused).toBe(false);

  const panel = page.getByRole("dialog", { name: TRACKS });

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(panel).toBeVisible();

  await holdKey(page, "Escape", 4);
  await expect(panel).toBeHidden();
  await expect(leave).toBeHidden();

  const { menu } = commandMenu(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leave).toBeHidden();

  const info = page.getByRole("region", { name: "Stream info" });

  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(info).toBeVisible();
  await player.press("Escape");
  await expect(info).toBeHidden();
  await expect(leave).toBeHidden();
  await expect(page).toHaveURL(onPlayer);
  await expect.poll(paused).toBe(false);

  await player.focus();

  await holdKey(page, "Escape", 4);
  await expect(leave).toBeVisible();
  await page.waitForTimeout(500);
  await expect(leave).toBeVisible();

  const stops: Array<string> = [];

  const onRequest = (request: Request) => {
    if (request.url().endsWith(MEDIA_ROUTES.stop)) stops.push(request.url());
  };

  page.on("request", onRequest);
  await page.keyboard.press("Tab");
  await expect(leave.getByRole("button", { name: "Leave", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.remux)}$`, "u"));
  await page.waitForTimeout(1_000);
  page.off("request", onRequest);
  expect(stops).toHaveLength(1);

  await playFromStart(MOVIES.remux, "remux");
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.remux)}$`, "u"));
  await expect(leave).toHaveCount(0);
});

test("a picture subtitle burns into a transcode and back out; a lower quality transcodes down", async () => {
  await playFromStart(MOVIES.pictures, "remux");

  const panel = page.getByRole("dialog", { name: TRACKS });

  const openPanel = async () => {
    if (await panel.isVisible()) return;
    await revealControls(page);
    await page.getByRole("button", { name: TRACKS }).click();
  };

  const choose = async (name: string) => {
    await openPanel();
    await panel.getByRole("radio", { name }).last().click();
  };

  await openPanel();
  await capture(page, "07-08-tracks-and-quality");

  let before = streams.length;

  await choose("English");
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("transcode-software");
  expect(streams.at(-1)?.burnedInSubtitle).toMatch(/^e\d+$/u);
  await expectPlayingPast(page, 1);

  before = streams.length;
  await choose("Off");
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "remux", burnedInSubtitle: undefined });

  before = streams.length;
  await choose("480p");
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "transcode-software", height: 480 });
  await expectPlayingPast(page, 1);

  before = streams.length;
  await page.reload();
  await expect.poll(() => streams.slice(before).at(-1)?.height).toBe(480);
  await expectPlayingPast(page, 0.5);
  await openPanel();
  await expect(panel.getByRole("radio", { name: "480p" })).toBeChecked();

  before = streams.length;
  await choose("Auto");
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
});

test("pausing while a stream moves to where it resumes keeps the position", async () => {
  const earlier = new Set((await owner.sdk.query("playback.active", {})).map(({ id }) => id));

  const leavePlayer = async () => {
    await leaveWithEscape(page);
    await expect
      .poll(async () => {
        const sessions = await owner.sdk.query("playback.active", {});

        return sessions.filter(
          ({ id, titleId: playing }) => playing === titleId(MOVIES.pictures) && !earlier.has(id),
        ).length;
      })
      .toBe(0);
  };

  await playFromStart(MOVIES.pictures, "remux");

  const { menu, playback } = commandMenu(page);

  const chooseQuality = async (name: RegExp) => {
    await page.keyboard.press("ControlOrMeta+k");
    await playback.getByRole("option", { name: /^Quality/u }).click();
    await menu.getByRole("listbox", { name: "Quality" }).getByRole("option", { name }).click();
  };

  let before = streams.length;

  await chooseQuality(/^480p/u);
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "transcode-software", height: 480 });
  await leavePlayer();

  const profile = await adultProfile(owner.sdk);

  const resumeHeld = async (positionMs: Milliseconds) => {
    const { sessionId } = await owner.sdk.mutate("playback.createSession", {
      profileId: profile.id,
      deviceId: DeviceId.make(`resume-seed-${run}-${String(positionMs)}`),
      titleId: titleId(MOVIES.pictures),
    });

    await owner.sdk.mutate("playback.endSession", { sessionId, positionMs });

    const planned = new Map<string, PlannedSegment>();

    const readPlan = async (route: Route) => {
      const response = await route.fetch();
      const body = await response.text();
      const streamId = HLS_PLAYLIST.exec(route.request().url())?.[1];
      const segment = segmentHolding(body, positionMs / 1000);

      if (streamId !== undefined && segment !== undefined) planned.set(streamId, segment);
      await route.fulfill({ response, body });
    };

    await page.route(HLS_PLAYLIST, readPlan);

    const release = await holdSegments(page, (url) => {
      const [, streamId = "", index] = HLS_SEGMENT.exec(url.pathname) ?? [];
      const segment = planned.get(streamId);

      return index !== undefined && segment !== undefined && Number(index) > segment.index;
    });

    before = streams.length;
    await page.goto(`/watch/${titleId(MOVIES.pictures)}`);
    await page
      .getByRole("button", {
        name: `Resume from ${formatTimecode(positionMs / 1000)}`,
        exact: true,
      })
      .click();
    await expect
      .poll(() => streams.slice(before).at(-1))
      .toMatchObject({ mode: "transcode-software", height: 480 });

    const streamId = streams.at(-1)?.streamId ?? "";

    await expect.poll(() => planned.get(streamId)).toBeDefined();

    return {
      segment: planned.get(streamId),
      release: async () => {
        await release();
        await page.unroute(HLS_PLAYLIST, readPlan);
      },
    };
  };

  const probeAt = PROBE_RESUME_MS / 1000;
  const probe = await resumeHeld(PROBE_RESUME_MS);

  await expect
    .poll(
      async () => {
        const state = await videoState(page);
        const end = await bufferedEnd(page, probeAt);

        return (
          end !== null &&
          state.currentTime > end - STALLED_SHORT_OF_EDGE_SECONDS &&
          state.readyState <= HAVE_CURRENT_DATA
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const edge = await bufferedEnd(page, probeAt);

  if (edge === null || probe.segment === undefined) throw new Error("The probe never buffered");
  expect(edge, `${probeAt}s resumed into ${JSON.stringify(probe.segment)}`).toBeGreaterThan(
    probe.segment.start,
  );

  await leavePlayer();
  await probe.release();

  const target = Milliseconds.make(Math.round(edge * 1000) - EDGE_MARGIN_MS);
  const start = target / 1000;
  const resumed = await resumeHeld(target);
  const video = page.getByTestId("player-video");

  expect(resumed.segment, "the stream resumes into the probed segment").toEqual(probe.segment);
  await expect.poll(() => bufferedEnd(page, start)).not.toBeNull();

  const held = await bufferedEnd(page, start);

  if (held === null) throw new Error(`The buffer dropped ${start}s`);

  // What makes the pause land at 0 on its own: the element holds the target's frame but too little
  // after it to finish the seek. A target with nothing buffered seeks correctly through a pause.
  expect(held, `resumed at ${start}s, buffered to ${held}s, probed to ${edge}s`).toBeCloseTo(
    edge,
    2,
  );
  expect(held - start).toBeGreaterThan(0);
  expect(held - start).toBeLessThanOrEqual(EDGE_WINDOW_SECONDS);
  expect(
    await video.evaluate((element) => element instanceof HTMLVideoElement && element.seeking),
  ).toBe(true);
  expect((await videoState(page)).currentTime).toBeCloseTo(start, 3);

  await video.evaluate((element) => {
    element.addEventListener(
      "pause",
      () => {
        if (!(element instanceof HTMLVideoElement)) return;
        element.dataset["pausedSeeking"] = String(element.seeking);
        element.dataset["pausedReadyState"] = String(element.readyState);
      },
      { once: true },
    );
  });
  await page.getByTestId("player").press("k");

  const pausedWith = () =>
    video.evaluate((element) =>
      element instanceof HTMLVideoElement
        ? {
            seeking: element.dataset["pausedSeeking"],
            readyState: Number(element.dataset["pausedReadyState"]),
          }
        : null,
    );

  await expect.poll(async () => (await pausedWith())?.seeking).toBe("true");
  expect((await pausedWith())?.readyState).toBeLessThan(HAVE_CURRENT_DATA);
  await resumed.release();
  await expect
    .poll(async () => {
      const state = await videoState(page);

      return state.paused && state.readyState >= HAVE_CURRENT_DATA;
    })
    .toBe(true);
  await expectPositionNear(page, start, 0.1);
  await page.waitForTimeout(1_000);
  expect(Math.abs((await videoState(page)).currentTime - start)).toBeLessThan(0.1);

  await leavePlayer();

  const busy = await resumeHeld(target);

  expect(busy.segment, "the stream resumes into the probed segment").toEqual(probe.segment);
  await expect.poll(() => bufferedEnd(page, start)).not.toBeNull();
  expect(
    await video.evaluate((element) => element instanceof HTMLVideoElement && element.seeking),
  ).toBe(true);

  const heldAgain = await bufferedEnd(page, start);

  if (heldAgain === null) throw new Error(`The buffer dropped ${start}s`);

  await video.evaluate(
    (element, { heldEnd, busyMs }) => {
      if (!(element instanceof HTMLVideoElement)) return;

      const ends = () =>
        Array.from({ length: element.buffered.length }, (_, index) => element.buffered.end(index));

      const watch = window.setInterval(() => {
        if (!ends().some((end) => end > heldEnd)) return;

        window.clearInterval(watch);

        const until = performance.now() + busyMs;

        while (performance.now() < until);
        element.pause();
      }, 0);

      // Capture on the document runs before the player's own listener on the element.
      document.addEventListener(
        "pause",
        () => {
          element.dataset["pausedSeeking"] = String(element.seeking);
          element.dataset["pausedAt"] = String(element.currentTime);
        },
        { capture: true, once: true },
      );
    },
    { heldEnd: heldAgain, busyMs: BUSY_MAIN_THREAD_MS },
  );
  await busy.release();

  const pausedAfterLanding = () =>
    video.evaluate((element) =>
      element instanceof HTMLVideoElement
        ? { seeking: element.dataset["pausedSeeking"], at: element.dataset["pausedAt"] }
        : null,
    );

  // Chrome may lose the seek at 0 before the pause dispatches, which the player must undo, or
  // finish it at the target first. Which one happens depends on the runner's load, so the test
  // asserts the outcome either way and records which it saw.
  await expect.poll(async () => (await pausedAfterLanding())?.seeking).toBeDefined();

  const landed = await pausedAfterLanding();

  test.info().annotations.push({
    type: "pause after landing",
    description: `seeking ${String(landed?.seeking)} at ${String(landed?.at)}s`,
  });
  await expect
    .poll(async () => {
      const state = await videoState(page);

      return state.paused && state.readyState >= HAVE_CURRENT_DATA;
    })
    .toBe(true);
  await expectPositionNear(page, start, 0.1);
  await page.waitForTimeout(1_000);
  expect(Math.abs((await videoState(page)).currentTime - start)).toBeLessThan(0.1);

  await video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return;

    element.dataset["lowest"] = String(element.currentTime);
    element.addEventListener("timeupdate", () => {
      element.dataset["lowest"] = String(
        Math.min(Number(element.dataset["lowest"]), element.currentTime),
      );
    });
  });
  await page.getByTestId("player").press("k");
  await expectPlayingPast(page, start + 1);
  expect(
    await video.evaluate((element) => Number(element.dataset["lowest"])),
    "playback goes on from where it resumed",
  ).toBeGreaterThan(start - 0.1);

  before = streams.length;
  await chooseQuality(/^Auto/u);
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
});

test("a quality the media service cannot encode now gives way to the stream that plays", async () => {
  const panel = page.getByRole("dialog", { name: TRACKS });

  const openPanel = async () => {
    if (await panel.isVisible()) return;
    await revealControls(page);
    await page.getByRole("button", { name: TRACKS }).click();
  };

  await refuseQualityCaps(page, 1_000);
  await playFromStart(MOVIES.pictures, "remux");
  await openPanel();
  await panel.getByRole("radio", { name: "720p" }).click();
  await openPanel();
  await panel.getByRole("radio", { name: "480p" }).click();

  await expect
    .poll(async () => {
      await openPanel();

      return panel.getByRole("radio", { name: "Auto" }).isChecked();
    })
    .toBe(true);
  await expectPlayingPast(page, 1);

  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
  await openPanel();
  await panel.getByRole("radio", { name: "480p" }).click();
  await expect.poll(() => streams.at(-1)?.height).toBe(480);
  await refuseQualityCaps(page);

  const before = streams.length;

  await page.reload();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await expectPlayingPast(page, 0.5);
  await openPanel();
  await expect(panel.getByRole("radio", { name: "Auto" })).toBeChecked();
  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
});

test("an MPEG-TS file remuxes to HLS", async () => {
  await playFromStart(MOVIES.remux, "remux");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Remux");
});

test("the playback timeline splits startup by stage, names the audio, and samples drift", async () => {
  await playFromStart(MOVIES.remux, "remux");
  await expectPlayingPast(page, DRIFT_SAMPLED_PAST_SECONDS, 45_000);
  await leaveWithEscape(page);

  await expect
    .poll(async () => (await latestWebTimeline(true))?.drift.status ?? null, { timeout: 30_000 })
    .toBe("measured");

  const diagnostics = await latestWebTimeline(true);
  const entries = diagnostics?.entries ?? [];

  const startups = entries.filter((entry) => entry.kind === "startup");

  const stages = startups.flatMap((entry) =>
    entry.details["startupMs"] !== undefined
      ? [
          ["negotiatedMs", "manifestLoadedMs", "firstFragmentMs", "firstFrameMs"].map((stage) =>
            Number(entry.details[stage]),
          ),
        ]
      : [],
  );

  const [negotiated = NaN, manifest = NaN, fragment = NaN, frame = NaN] = stages[0] ?? [];

  expect(stages, "one startup with every stage").toHaveLength(1);
  expect(negotiated).toBeGreaterThan(0);
  expect(manifest).toBeGreaterThanOrEqual(negotiated);
  expect(fragment).toBeGreaterThanOrEqual(manifest);
  expect(frame).toBeGreaterThanOrEqual(fragment);
  expect(startups, "one entry per startup").toHaveLength(1);
  expect(startups[0]?.details["segmentLoads"], "the first segment loads").toEqual(
    expect.arrayContaining([expect.objectContaining({ index: 0 })]),
  );
  expect(
    entries.find((entry) => entry.kind === "player-attached")?.details["audioCodec"],
  ).toBeTruthy();
  expect(diagnostics?.drift).toMatchObject({
    status: "measured",
    method: "video-frame-vs-media-clock",
  });
  expect((await latestWebTimeline(false))?.drift.status).toBe("not-measured");
});

test("a stall while segments are held back reaches the playback timeline", async () => {
  await playFromStart(MOVIES.remux, "remux");

  const segments = /\/media\/hls\/[^/]+\/\d+\/\d+\.m4s/u;

  await page.route(segments, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CONGESTED_SEGMENT_DELAY_MS));
    // hls.js may give up on a held request meanwhile, which leaves nothing to continue.
    await route.continue().catch(() => undefined);
  });

  await clickScrubber(page, SEEK_FRACTION);
  await expectPlayingPast(page, PAST_THE_HELD_SEGMENTS_SECONDS, 45_000);
  await page.unroute(segments);

  await expect
    .poll(async () => (await latestWebTimeline())?.entries.map((entry) => entry.kind) ?? [], {
      timeout: 30_000,
    })
    .toEqual(
      expect.arrayContaining([
        "stream-started",
        "player-attached",
        "buffering-started",
        "buffering-ended",
        "slow-fragment",
      ]),
    );

  const diagnostics = await latestWebTimeline();

  const stalls = (diagnostics?.entries ?? []).flatMap((entry) =>
    entry.kind === "buffering-ended" ? [Number(entry.details["stalledMs"])] : [],
  );

  expect(diagnostics?.platform).toBe("web");
  expect(diagnostics?.drift.status).toBe("not-measured");
  expect(Math.max(...stalls)).toBeGreaterThanOrEqual(3_000);
});

test("AC-3 audio is converted while the video is copied", async () => {
  await playFromStart(MOVIES.audio, "audio-transcode");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Remux");
  await expect(page.getByRole("region", { name: "Stream info" })).toContainText("converted");
});

test("HEVC transcodes in software, and a seek past what is produced moves the stream", async () => {
  await playFromStart(MOVIES.transcode, "transcode-software");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Transcode");
  await capture(page, "07-03-stream-info");
  await page.getByRole("button", { name: "Close stream info" }).click();

  const seek = page.waitForResponse((response) => response.url().endsWith("/api/playback/seek"));

  await clickScrubber(page, 0.8);
  expect((await seek).ok()).toBe(true);
  await expectPlayingPast(page, 90, 45_000);
});

test("the next episode plays itself after the countdown; Watch credits cancels it", async () => {
  const [first, second] = episodes;

  if (first === undefined || second === undefined) throw new Error("The show has no episodes");

  await page.goto(`/watch/${titleId(SHOW)}?episodeId=${first}&start=0`);
  await expectPlayingPast(page, 0.5);

  const player = page.getByTestId("player");

  await player.press("l");
  await player.press("l");
  await player.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Watch credits" })).toBeVisible({
    timeout: 10_000,
  });

  const card = page.getByRole("region", { name: "Next episode" });
  const still = card.locator('[data-slot="next-episode-still"]');
  const image = still.locator('[data-slot="next-episode-image"]');

  await expect(card.getByRole("heading", { name: EPISODES[1] })).toBeVisible();
  await expect(card).toContainText("S1:E2 · 48m");
  await expect(card).toContainText(SLACK_TIDE.plot);
  await expect(image).toHaveCSS("background-image", /^url\(/u);
  await expect(card.getByRole("button", { name: "Play next" })).toBeFocused();
  await expect(card.getByRole("button", { name: "Play next" })).toHaveAccessibleName("Play next");
  await expect(card.getByRole("button", { name: "Play next" })).toHaveAccessibleDescription(
    /^Starts in \d+ seconds?$/u,
  );
  const frame = await player.boundingBox();

  await expect.poll(() => page.getByTestId("player-video").boundingBox()).toEqual(frame);
  await capture(page, "07-05-autoplay-next");
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"), { timeout: 20_000 });
  await expectPlayingPast(page, 0.5);

  await player.press("l");
  await player.press("l");
  await player.press("ArrowRight");

  const credits = page.getByRole("button", { name: "Watch credits" });

  await expect(credits).toBeVisible({ timeout: 10_000 });

  await expect(card.getByRole("heading", { name: EPISODES[2] })).toBeVisible();
  await expect(image).toHaveCount(0);
  await expect(still.locator("svg")).toBeVisible();

  const video = page.getByTestId("player-video");
  const onCredits = { position: { x: 200, y: 450 } } as const;

  await video.click(onCredits);
  await expect(card).toBeHidden();
  await expect.poll(() => controlsShown(page)).toBe(true);
  await page.waitForTimeout(11_000);
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  await video.click(onCredits);
  await expect(credits).toBeVisible();

  await player.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await page.waitForTimeout(11_000);
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeHidden();
  await credits.click();
  await expect(credits).toBeHidden();
  await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(29);
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
});

const controlsShown = (target: Page) =>
  target.locator('[data-slot="player-controls"]').evaluate((element) => {
    const { opacity } = getComputedStyle(element);

    return opacity === "1";
  });

const IDLE_MS = 4_000;

test("hovering the volume button opens a slider that sets the level live and stays in step with mute", async () => {
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);

  const before = streams.length;
  const mute = page.getByRole("button", { name: "Mute", exact: true });
  const unmute = page.getByRole("button", { name: "Unmute", exact: true });
  const slider = page.getByRole("slider", { name: "Volume" });
  const control = page.locator('[data-slot="volume-slider"]');

  await expect(slider).toHaveCount(0);
  await mute.hover();
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", "100%");

  const box = await control.boundingBox();

  if (box === null) throw new Error("The volume slider is not on screen");

  const at = (fraction: number) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height * (1 - fraction),
  });

  const start = at(1);

  await page.mouse.move(start.x, start.y, { steps: 8 });
  await page.waitForTimeout(IDLE_MS);
  await expect(slider).toBeVisible();
  expect(await controlsShown(page)).toBe(true);
  await capture(page, "07-13-volume-slider");

  await page.mouse.down();
  await page.mouse.move(at(0.6).x, at(0.6).y, { steps: 4 });
  await expect.poll(async () => (await videoState(page)).volume).toBeLessThan(0.75);
  await page.mouse.move(at(0.3).x, at(0.3).y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await videoState(page)).volume).toBeLessThan(0.4);

  const level = (await videoState(page)).volume;

  expect(level).toBeGreaterThan(0.2);
  await expect(slider).toHaveAttribute("aria-valuetext", `${String(Math.round(level * 100))}%`);

  await mute.click();
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await expect(slider).toHaveAttribute("aria-valuetext", "Muted");
  await unmute.click();
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);
  expect((await videoState(page)).volume).toBeCloseTo(level, 2);

  await page.mouse.move(at(0.3).x, at(0.3).y);
  await page.mouse.down();
  await page.mouse.move(at(0).x, box.y + box.height + 8, { steps: 6 });
  await page.mouse.up();
  await expect(unmute).toBeVisible();
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await unmute.click();
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(level, 2);
  expect((await videoState(page)).muted).toBe(false);

  const frame = await page.getByTestId("player").boundingBox();

  if (frame === null) throw new Error("The player is not on screen");

  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 3, { steps: 4 });
  await expect(slider).toHaveCount(0);
  await expect.poll(() => controlsShown(page), { timeout: IDLE_MS + 2_000 }).toBe(false);

  await revealControls(page);
  await page.getByRole("button", { name: "Forward 10 seconds" }).focus();
  await page.keyboard.press("Tab");
  await expect(mute).toBeFocused();
  await expect(slider).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(slider).toBeFocused();

  const keyed = Math.round((await videoState(page)).volume * 100);

  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => Math.round((await videoState(page)).volume * 100))
    .toBe(Math.min(100, keyed + 1));
  await expect(slider).toHaveAttribute("aria-valuetext", `${String(Math.min(100, keyed + 1))}%`);
  await page.keyboard.press("PageDown");
  await expect
    .poll(async () => Math.round((await videoState(page)).volume * 100))
    .toBe(Math.min(100, keyed + 1) - 10);

  await page.keyboard.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await page.keyboard.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  await page.keyboard.press("Escape");
  await expect(slider).toHaveCount(0);
  await expect(mute).toBeFocused();
  await expect(leaveDialog(page)).toBeHidden();

  expect((await videoState(page)).paused).toBe(false);
  expect(streams.length).toBe(before);
});

const SWAP_ROUNDS = 16;

// Muting swaps the icon under the pointer. If the icon took the pointer, a pointer leaving before
// the browser hovers the new icon would send its `pointerout` to the detached one and React would
// miss the leave. The hit check catches that at once; the rounds catch the race it causes.
test("the volume slider closes when the pointer leaves right after mute swaps its icon", async () => {
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);

  const mute = page.getByRole("button", { name: "Mute", exact: true });
  const unmute = page.getByRole("button", { name: "Unmute", exact: true });
  const slider = page.getByRole("slider", { name: "Volume" });
  const frame = await page.getByTestId("player").boundingBox();

  if (frame === null) throw new Error("The player is not on screen");

  const hitsItself = await mute.evaluate((button) => {
    const { x, y, width, height } = button.getBoundingClientRect();

    return document.elementFromPoint(x + width / 2, y + height / 2) === button;
  });

  expect(hitsItself).toBe(true);

  const swapAndLeave = async (round: number): Promise<void> => {
    if (round === SWAP_ROUNDS) return;

    const button = round % 2 === 0 ? mute : unmute;

    await button.hover();
    await expect(slider).toBeVisible();
    await button.click();
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 3, { steps: 4 });
    await expect(slider).toHaveCount(0);
    await swapAndLeave(round + 1);
  };

  await swapAndLeave(0);
  expect((await videoState(page)).muted).toBe(false);
});

test("the episode picker browses seasons and plays earlier and later episodes in the player", async () => {
  const [first, second] = episodes;
  const [later] = seasonTwo;

  if (first === undefined || second === undefined || later === undefined) {
    throw new Error("The show has no episodes");
  }

  await page.goto(`/watch/${titleId(SHOW)}?episodeId=${second}&start=0`);
  await expectPlayingPast(page, 0.5);

  const player = page.getByTestId("player");
  const button = page.getByRole("button", { name: "Episodes", exact: true });
  const picker = page.getByRole("dialog", { name: "Episodes" });
  const current = picker.locator('[aria-current="true"]');

  await revealControls(page);
  await expect(page.getByRole("button", { name: "Next episode" })).toBeVisible();
  await button.click();
  await expect(picker).toBeVisible();

  await expect(picker.getByRole("button", { name: "Season 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(picker.locator('[data-slot="episode-row"]')).toHaveText([
    new RegExp(`^1\\s*${EPISODES[0]}`, "u"),
    new RegExp(`^2\\s*${EPISODES[1]}`, "u"),
    new RegExp(`^3\\s*${EPISODES[2]}`, "u"),
  ]);
  await expect(current).toContainText(EPISODES[1]);
  await expect(current).toBeFocused();

  await page.waitForTimeout(IDLE_MS);
  expect(await controlsShown(page)).toBe(true);
  await capture(page, "07-14-episode-picker");

  const volume = (await videoState(page)).volume;

  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("button", { name: new RegExp(EPISODES[2], "u") })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(picker.getByRole("button", { name: new RegExp(EPISODES[0], "u") })).toBeFocused();
  expect((await videoState(page)).volume).toBe(volume);

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  expect((await videoState(page)).paused).toBe(false);

  await revealControls(page);
  await button.click();
  await picker.getByRole("button", { name: "Season 2", exact: true }).click();
  await expect(picker.locator('[data-slot="episode-row"]')).toHaveText([
    new RegExp(`^1\\s*${SEASON_TWO[0]}`, "u"),
  ]);
  await capture(page, "07-15-episode-picker-season");
  await picker.getByRole("button", { name: new RegExp(SEASON_TWO[0], "u") }).click();
  await expect(page).toHaveURL(new RegExp(`episodeId=${later}`, "u"));
  await expectPlayingPast(page, 0.5);

  await player.press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await revealControls(page);
  await button.click();
  await expect(current).toContainText(SEASON_TWO[0]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement?.contains(
            document.querySelector('[data-slot="episode-list"]'),
          ) ?? false,
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await revealControls(page);
  await button.click();
  await picker.getByRole("button", { name: "Season 1", exact: true }).click();
  await picker.getByRole("button", { name: new RegExp(EPISODES[0], "u") }).click();
  await expect(page).toHaveURL(new RegExp(`episodeId=${first}`, "u"));
  await expectPlayingPast(page, 0.5);
  await page.evaluate(() => document.exitFullscreen().catch(() => undefined));

  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);
  await expect(page.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await expect(button).toHaveCount(0);
});

test("touch: a tap opens the volume slider before muting, and the picker plays an episode", async ({
  browser,
}) => {
  if (stack === null) return;

  const [first, second] = episodes;

  if (first === undefined || second === undefined) throw new Error("The show has no episodes");

  const tablet = await browser.newContext({ ...devices["Galaxy Tab S9 landscape"] });
  const touch = await tablet.newPage();

  await useSession(touch, owner);
  await touch.goto(`/watch/${titleId(SHOW)}?episodeId=${first}&start=0`);
  await expectPlayingPast(touch, 0.5);
  await revealControls(touch);

  const slider = touch.getByRole("slider", { name: "Volume" });

  await touch.getByRole("button", { name: "Mute", exact: true }).tap();
  await expect(slider).toBeVisible();
  expect((await videoState(touch)).muted).toBe(false);
  await touch.getByRole("button", { name: "Mute", exact: true }).tap();
  await expect.poll(async () => (await videoState(touch)).muted).toBe(true);
  await touch.getByRole("button", { name: "Unmute", exact: true }).tap();
  await expect.poll(async () => (await videoState(touch)).muted).toBe(false);

  await expect(slider).toHaveCount(0, { timeout: 6_000 });

  await touch.getByRole("button", { name: "Episodes", exact: true }).tap();
  await expect(slider).toHaveCount(0);

  const picker = touch.getByRole("dialog", { name: "Episodes" });

  await picker.getByRole("button", { name: new RegExp(EPISODES[1], "u") }).tap();
  await expect(touch).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  await expectPlayingPast(touch, 0.5);
  await tablet.close();

  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const handset = await phone.newPage();

  await useSession(handset, owner);
  await handset.goto(`/watch/${titleId(SHOW)}?episodeId=${second}&start=0`);
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();
  await handset.getByRole("button", { name: "Episodes", exact: true }).tap();

  const phonePicker = handset.getByRole("dialog", { name: "Episodes" });

  await expect(phonePicker.locator('[aria-current="true"]')).toContainText(EPISODES[1]);
  await expect(phonePicker).toHaveCSS("opacity", "1");

  const pill = await handset.getByRole("button", { name: "Episodes", exact: true }).boundingBox();
  const panel = await phonePicker.boundingBox();

  if (pill === null || panel === null) throw new Error("The picker is not on screen");
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(pill.y);
  await capture(handset, "07-16-ios-episode-picker");
  await phonePicker.getByRole("button", { name: new RegExp(EPISODES[0], "u") }).tap();
  await expect(handset).toHaveURL(new RegExp(`episodeId=${first}`, "u"));
  await phone.close();
});

test("a file gone from disk says so instead of playing", async () => {
  await rm(join(workspace, "Films", `${MOVIES.missing} (2021)`, `${MOVIES.missing} (2021).mp4`));
  await page.goto(`/watch/${titleId(MOVIES.missing)}?start=0`);
  await expect(page.getByRole("heading", { name: "We can't find this file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show missing files" })).toBeVisible();
  await capture(page, "07-09-file-missing");
});

test("a phone plays in its own layout, with brightness and volume sliders", async ({ browser }) => {
  if (stack === null) return;

  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const handset = await phone.newPage();

  await useSession(handset, owner);
  await handset.goto(`/watch/${titleId(MOVIES.direct)}?start=0`);
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();
  await expect(handset.getByRole("slider", { name: "Brightness" })).toBeVisible();
  await expect(handset.getByRole("slider", { name: "Volume" })).toBeVisible();
  await expect(handset.getByRole("button", { name: "Close player" })).toBeVisible();
  await capture(handset, "07-10-ios-player");

  await handset.getByRole("button", { name: "Close player" }).tap();
  await expect(handset).toHaveURL(new RegExp(`/title/${titleId(MOVIES.direct)}$`, "u"));
  await expect(leaveDialog(handset)).toHaveCount(0);
  await phone.close();
});
