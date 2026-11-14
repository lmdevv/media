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

const mediaDir = fileURLToPath(new URL("../../media", import.meta.url));

/** A running media service. */
export interface MediaService {
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
    await exited;
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

/** Writes the fixture album into a new folder and returns the folder and the album's title. */
export const writeMusicLibrary = async (): Promise<{
  readonly root: string;
  readonly album: string;
}> => {
  const root = mkdtempSync(join(tmpdir(), "music-e2e-"));
  const album = `Fixture Tones ${root.slice(-6)}`;
  const folder = join(root, ARTIST, album);
  const ffmpeg = process.env["FFMPEG_PATH"] ?? "ffmpeg";

  await mkdir(folder, { recursive: true });

  await Promise.all(
    SONGS.map((song, index) =>
      run(ffmpeg, [
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
        `artist=${ARTIST}`,
        "-metadata",
        `album_artist=${ARTIST}`,
        "-metadata",
        `album=${album}`,
        "-metadata",
        `track=${String(index + 1)}`,
        join(folder, `${String(index + 1).padStart(2, "0")} ${song.title}.flac`),
      ]),
    ),
  );

  return { root, album };
};
