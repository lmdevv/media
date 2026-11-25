import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MEDIA_ROUTES } from "@media/contracts/media-playback";
import { expect } from "@playwright/test";

import { isConnected } from "./media-health";
import type { StackEnv } from "./stack-env";

const run = promisify(execFile);

const mediaDir = fileURLToPath(new URL("../../../media", import.meta.url));

/** How long a stop may take before the suite calls it hung: Docker's wait before it kills. */
const STOP_TIMEOUT_MS = 10_000;

/** A running media service. */
export interface MediaService {
  /** Stops it with SIGTERM; fails when it is still running `STOP_TIMEOUT_MS` later. */
  readonly stop: () => Promise<void>;
}

/**
 * Builds and starts the media service against `stack` with `libraryRoot` approved, and resolves
 * once it is signed in to the core.
 */
export const startMediaService = async (
  stack: StackEnv,
  libraryRoot: string,
): Promise<MediaService> => {
  execFileSync(process.execPath, [`${mediaDir}/scripts/build.ts`], { stdio: "pipe" });

  const child = spawn(process.execPath, [`${mediaDir}/dist/main.js`], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...stack.mediaEnv,
      LIBRARY_ROOTS: libraryRoot,
      HARDWARE_ACCELERATION: "none",
      MIN_FREE_TRANSCODE_MB: "1",
    },
  });

  let logs = "";

  child.stdout.on("data", (chunk: Buffer) => {
    logs += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString("utf8");
  });

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");

    let timer: ReturnType<typeof setTimeout> | undefined;

    const inTime = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
      }),
    ]);

    clearTimeout(timer);

    if (inTime) return;

    child.kill("SIGKILL");
    await exited;

    throw new Error(
      `The media service ignored SIGTERM for ${String(STOP_TIMEOUT_MS)} ms:\n${logs}`,
    );
  };

  const connected = async (): Promise<boolean> =>
    isConnected(
      await fetch(`${stack.mediaUrl}${MEDIA_ROUTES.health}`)
        .then((response) => response.text())
        .catch(() => ""),
    );

  await expect
    .poll(async () => (child.exitCode === null ? connected() : Promise.reject(new Error(logs))), {
      timeout: 30_000,
    })
    .toBe(true);

  return { stop };
};

/** The fixture album's two songs: six seconds of a tone each, FLAC with tags, as a scan reads them. */
export const FIRST_SONG = "First Tone";

export const SECOND_SONG = "Second Tone";

/** The fixture album's artist; each run names its album anew, so earlier runs' albums never match. */
const ARTIST = "E2E Ensemble";

const SONGS = [
  { title: FIRST_SONG, seconds: 6, frequency: 330 },
  { title: SECOND_SONG, seconds: 6, frequency: 440 },
] as const;

/** One fixture song: a tone, written as FLAC with the tags a scan reads. */
export interface FixtureSong {
  readonly title: string;
  readonly artist: string;
  readonly albumArtist: string;
  readonly album: string;
  readonly track: number;
  readonly seconds: number;
  readonly frequency: number;
}

/** Writes each song under `root` in an album artist and album folder, as FLAC with its tags. */
export const writeSongs = async (
  root: string,
  songs: ReadonlyArray<FixtureSong>,
): Promise<void> => {
  const ffmpeg = process.env["FFMPEG_PATH"] ?? "ffmpeg";

  await Promise.all(
    songs.map(async (song) => {
      const folder = join(root, song.albumArtist, song.album);

      await mkdir(folder, { recursive: true });
      await run(ffmpeg, [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${String(song.frequency)}:sample_rate=44100:duration=${String(song.seconds)}`,
        "-metadata",
        `title=${song.title}`,
        "-metadata",
        `artist=${song.artist}`,
        "-metadata",
        `album_artist=${song.albumArtist}`,
        "-metadata",
        `album=${song.album}`,
        "-metadata",
        `track=${String(song.track)}`,
        join(folder, `${String(song.track).padStart(2, "0")} ${song.title}.flac`),
      ]);
    }),
  );
};

/**
 * Writes the fixture album into a new folder and returns the folder and the album's title.
 *
 * @param seconds - How long each song lasts, 6 seconds unless a test needs time inside a song.
 */
export const writeMusicLibrary = async (
  seconds?: number,
): Promise<{
  readonly root: string;
  readonly album: string;
}> => {
  const root = mkdtempSync(join(tmpdir(), "music-e2e-"));
  const album = `Fixture Tones ${root.slice(-6)}`;

  await writeSongs(
    root,
    SONGS.map((song, index) => ({
      title: song.title,
      artist: ARTIST,
      albumArtist: ARTIST,
      album,
      track: index + 1,
      seconds: seconds ?? song.seconds,
      frequency: song.frequency,
    })),
  );

  return { root, album };
};
