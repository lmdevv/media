import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LibraryId, TitleId } from "@media/contracts/ids";
import type { LibraryAccess, LibraryKind } from "@media/contracts/models/catalog";
import type { MoviesSdk } from "@media/sdk/promise";
import { expect } from "@playwright/test";
import type { Locator, Page, Route } from "@playwright/test";

import type { StackEnv } from "../stack/stack-env";

const run = promisify(execFile);

const ffmpegPath = process.env["FFMPEG_PATH"] ?? "ffmpeg";

interface ClipAudio {
  readonly codec: "aac" | "ac3";
  readonly language: string;
}

/** How to encode one clip. The container follows the output's extension. */
export interface ClipSpec {
  readonly seconds: number;
  /** H.264 plays in every browser; Chromium has no HEVC decoder, so HEVC is transcoded. */
  readonly video: "h264" | "hevc";
  readonly audio: ReadonlyArray<ClipAudio>;
  /** Chapter markers: start seconds and titles; each runs to the next one or the end. */
  readonly chapters?: ReadonlyArray<{ readonly start: number; readonly title: string }>;
  /** Picture size; 640x360 when absent. */
  readonly size?: string;
  /** A subtitle-only file whose first track is copied in, with its language. */
  readonly subtitles?: { readonly file: string; readonly language: string };
}

const chapterMetadata = (chapters: NonNullable<ClipSpec["chapters"]>, seconds: number): string =>
  [
    ";FFMETADATA1",
    ...chapters.flatMap((chapter, index) => [
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${String(chapter.start * 1000)}`,
      `END=${String((chapters[index + 1]?.start ?? seconds) * 1000)}`,
      `title=${chapter.title}`,
    ]),
    "",
  ].join("\n");

const VIDEO_ARGS: Readonly<Record<ClipSpec["video"], ReadonlyArray<string>>> = {
  h264: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"],
  hevc: [
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-x265-params",
    "log-level=error",
  ],
};

/**
 * Encodes a 640×360, 24 fps test pattern with a keyframe every two seconds (as players seek to
 * keyframes) and one tone per audio track, so each track is audibly its own.
 */
export const encodeClip = async (output: string, spec: ClipSpec): Promise<void> => {
  const duration = String(spec.seconds);

  const audioInputs = spec.audio.flatMap((_, index) => [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${String(330 + index * 110)}:sample_rate=48000:duration=${duration}`,
  ]);

  const audioArgs = spec.audio.flatMap((track, index) => [
    "-map",
    `${String(index + 1)}:a`,
    `-c:a:${String(index)}`,
    track.codec,
    `-ac:a:${String(index)}`,
    "2",
    `-metadata:s:a:${String(index)}`,
    `language=${track.language}`,
  ]);

  await mkdir(dirname(output), { recursive: true });

  const chapters = spec.chapters ?? [];
  const metadata = `${output}.chapters.txt`;

  if (chapters.length > 0) await writeFile(metadata, chapterMetadata(chapters, spec.seconds));

  const chapterArgs =
    chapters.length === 0 ? [] : ["-i", metadata, "-map_chapters", String(spec.audio.length + 1)];

  const subtitleInput = spec.audio.length + 1 + (chapters.length === 0 ? 0 : 1);

  await run(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${spec.size ?? "640x360"}:rate=24:duration=${duration}`,
    ...audioInputs,
    ...chapterArgs,
    ...(spec.subtitles === undefined ? [] : ["-i", spec.subtitles.file]),
    "-map",
    "0:v",
    ...VIDEO_ARGS[spec.video],
    "-g",
    "48",
    ...audioArgs,
    ...(spec.subtitles === undefined
      ? []
      : [
          "-map",
          `${String(subtitleInput)}:s:0`,
          "-c:s",
          "copy",
          "-metadata:s:s:0",
          `language=${spec.subtitles.language}`,
        ]),
    ...(output.endsWith(".mp4") ? ["-movflags", "+faststart"] : []),
    output,
  ]);

  if (chapters.length > 0) await rm(metadata);
};

/** An NFO that names a movie, so scans match it without a metadata provider. */
export const movieNfo = (name: string, year: number): string => `<?xml version="1.0"?>
<movie>
  <title>${name}</title>
  <year>${String(year)}</year>
</movie>
`;

/** An NFO that names a show. */
export const showNfo = (name: string, year: number): string => `<?xml version="1.0"?>
<tvshow>
  <title>${name}</title>
  <year>${String(year)}</year>
</tvshow>
`;

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

interface EpisodeDetails {
  readonly plot?: string;
  readonly runtimeMinutes?: number;
}

/** An NFO that names an episode, with its synopsis and runtime when given. */
export const episodeNfo = (
  season: number,
  episode: number,
  title: string,
  details: EpisodeDetails = {},
): string =>
  [
    `<?xml version="1.0"?>`,
    `<episodedetails>`,
    `  <title>${escapeXml(title)}</title>`,
    `  <season>${String(season)}</season>`,
    `  <episode>${String(episode)}</episode>`,
    ...(details.runtimeMinutes === undefined
      ? []
      : [`  <runtime>${String(details.runtimeMinutes)}</runtime>`]),
    ...(details.plot === undefined ? [] : [`  <plot>${escapeXml(details.plot)}</plot>`]),
    `</episodedetails>`,
    ``,
  ].join("\n");

/** Makes a temporary folder for a suite's clips. */
export const makeWorkspace = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Removes a suite's folder, or a file in it. */
export const removePath = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Writes `text` to `path`, creating its folder. */
export const writeText = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/**
 * The stack's media service without a metadata provider, so scans name titles from their NFO
 * files and never reach the network.
 */
export const offline = (stack: StackEnv): StackEnv => ({
  ...stack,
  mediaEnv: Object.fromEntries(
    Object.entries(stack.mediaEnv).filter(([name]) => name !== "TMDB_API_KEY"),
  ),
});

const SCAN_TIMEOUT_MS = 60_000;

/** Creates a library over `root` and waits until its first scan succeeded. */
export const scanLibrary = async (
  sdk: MoviesSdk,
  library: {
    readonly name: string;
    readonly kind: LibraryKind;
    readonly root: string;
    readonly access: LibraryAccess;
  },
): Promise<LibraryId> => {
  const created = await sdk.mutate("libraries.create", {
    name: library.name,
    kind: library.kind,
    roots: [library.root],
    access: library.access,
  });

  await expect
    .poll(async () => (await sdk.query("jobs.get", { jobId: created.jobId })).status, {
      timeout: SCAN_TIMEOUT_MS,
    })
    .toBe("succeeded");

  return created.libraryId;
};

/** The first profile of the signed-in account that needs no PIN and is not a kids profile. */
export const adultProfile = async (sdk: MoviesSdk) => {
  const profiles = await sdk.query("profiles.list", {});
  const profile = profiles.find((each) => !each.locked && !each.kids) ?? profiles[0];

  if (profile === undefined) throw new Error("The account has no profile");

  return profile;
};

/** The ids of a library's titles by name. */
export const titlesByName = async (
  sdk: MoviesSdk,
  libraryId: LibraryId,
): Promise<ReadonlyMap<string, TitleId>> => {
  const profile = await adultProfile(sdk);

  const page = await sdk.query("titles.list", {
    profileId: profile.id,
    libraryId,
    limit: 100,
  });

  return new Map(page.items.map((title) => [title.name, title.id]));
};

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: the element has the frame at its position. */
export const HAVE_CURRENT_DATA = 2;

const SEGMENTS = /\/media\/hls\/[^/]+\/\d+\/\d+\.m4s/u;

/**
 * Holds the page's requests for `segments`, a pattern or a test of each URL, until the returned
 * function lets them through, as a network that stops answering does.
 */
export const holdSegments = async (
  page: Page,
  segments: RegExp | ((url: URL) => boolean) = SEGMENTS,
): Promise<() => Promise<void>> => {
  const held: Array<Route> = [];
  let holding = true;

  const handler = async (route: Route): Promise<void> => {
    if (holding) {
      held.push(route);

      return;
    }

    await route.continue();
  };

  await page.route(segments, handler);

  return async () => {
    holding = false;
    await page.unroute(segments, handler);
    // A request the player gave up on while held fails to continue; it is no longer wanted.
    await Promise.all(held.map((route) => route.continue().catch(() => undefined)));
  };
};

/** What the player's `<video>` element reports at one instant. */
export interface VideoState {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly muted: boolean;
  readonly volume: number;
  /** `Date.now()` in the page when it was read. */
  readonly at: number;
}

/** Reads the player's `<video>` element. */
export const videoState = (page: Page): Promise<VideoState> =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    return {
      currentTime: element.currentTime,
      paused: element.paused,
      readyState: element.readyState,
      muted: element.muted,
      volume: element.volume,
      at: Date.now(),
    };
  });

/** Waits until the player plays past `seconds`. */
export const expectPlayingPast = async (
  page: Page,
  seconds: number,
  timeout = 30_000,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const state = await videoState(page);

        return !state.paused && state.currentTime > seconds;
      },
      { timeout },
    )
    .toBe(true);
};

/** Waits until the player's position is within `tolerance` seconds of `seconds`. */
export const expectPositionNear = async (
  page: Page,
  seconds: number,
  tolerance: number,
  timeout = 15_000,
): Promise<void> => {
  await expect
    .poll(async () => Math.abs((await videoState(page)).currentTime - seconds) <= tolerance, {
      timeout,
    })
    .toBe(true);
};

const MARKS = { start: "movies:playback-start", firstFrame: "movies:first-frame" } as const;

/**
 * Milliseconds from the last playback start to its first frame: starting the session,
 * negotiating, loading, and decoding.
 */
export const firstFrameMs = (page: Page): Promise<number> =>
  page.evaluate((marks) => {
    const start = performance.getEntriesByName(marks.start).at(-1);
    const frame = performance.getEntriesByName(marks.firstFrame).at(-1);

    if (start === undefined || frame === undefined) throw new Error("No first frame was marked");

    return Math.round(frame.startTime - start.startTime);
  }, MARKS);

/**
 * How far `guest` is from `host` in milliseconds (positive when ahead), from simultaneous reads of
 * both elements while both play. Both pages run in one browser, so their `Date.now()` agree, and
 * the host's position is carried forward to the instant the guest's was read.
 */
export const driftMs = async (host: Page, guest: Page): Promise<number> => {
  const [hostState, guestState] = await Promise.all([videoState(host), videoState(guest)]);
  const hostAtGuest = hostState.currentTime + (guestState.at - hostState.at) / 1000;

  return Math.round((guestState.currentTime - hostAtGuest) * 1000);
};

/** Shows the auto-hiding controls by moving the pointer over the player. */
export const revealControls = async (page: Page): Promise<void> => {
  const player = page.getByTestId("player");
  const box = await player.boundingBox();

  if (box === null) throw new Error("The player is not on screen");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10);
};

/** The player's "Leave playback?" confirmation. */
export const leaveDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Leave playback?" });

/** Leaves the player as a viewer does from the keyboard: Escape, then Leave in the confirmation. */
export const leaveWithEscape = async (page: Page): Promise<void> => {
  await page.getByTestId("player").press("Escape");
  await leaveDialog(page).getByRole("button", { name: "Leave", exact: true }).click();
};

interface CommandMenuParts {
  readonly menu: Locator;
  readonly playback: Locator;
}

/** The command menu and its list of player commands. */
export const commandMenu = (page: Page): CommandMenuParts => {
  const menu = page.getByRole("dialog", { name: "Command menu" });

  return { menu, playback: menu.getByRole("group", { name: "Playback" }) };
};

/** Holds `key` down through `repeats` auto-repeats, then lets go, as a key held by a finger does. */
export const holdKey = async (page: Page, key: string, repeats: number): Promise<void> => {
  const repeat = async (left: number): Promise<void> => {
    if (left === 0) return;
    await page.keyboard.down(key);
    await repeat(left - 1);
  };

  await page.keyboard.down(key);
  await repeat(repeats);
  await page.keyboard.up(key);
};

/** Clicks the scrubber at `fraction` of its width, as a viewer seeks with the mouse. */
export const clickScrubber = async (page: Page, fraction: number): Promise<void> => {
  await revealControls(page);

  const box = await page.locator('[data-slot="scrubber"]').boundingBox();

  if (box === null) throw new Error("The scrubber is not on screen");

  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
};

/**
 * Saves a JPEG of `page` to `$E2E_SCREENSHOTS/<name>.jpg` when that folder is set, for design
 * review against Paper.
 */
export const capture = async (page: Page, name: string): Promise<void> => {
  const folder = process.env["E2E_SCREENSHOTS"];

  if (folder === undefined || folder === "") return;

  await page.getByRole("button", { name: /TanStack Router/u }).evaluateAll((buttons) => {
    for (const button of buttons) {
      if (button instanceof HTMLElement) button.style.visibility = "hidden";
    }
  });
  await page.screenshot({ path: join(folder, `${name}.jpg`), type: "jpeg", quality: 72 });
};
