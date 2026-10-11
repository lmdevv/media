/**
 * Short generated audio files for the browser tests. Sine tones have no silence of their own, so
 * any silence in the captured output is a gap the player introduced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { fixturesDir } from "./config.ts";

/** One generated file and the tags the seed gives it. */
export interface Fixture {
  readonly file: string;
  readonly title: string;
  readonly codec: string;
  readonly lossless: boolean;
  readonly durationMs: number;
  readonly frequency: number;
}

const encoders = new Map([
  ["wav", ["-c:a", "pcm_s16le"]],
  ["flac", ["-c:a", "flac"]],
  ["mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]],
  ["opus", ["-c:a", "libopus", "-b:a", "128k"]],
]);

/** Engine test tones: WAV for the gap measurement, plus one file per common codec. */
const engineFixtures: ReadonlyArray<Fixture> = [
  {
    file: "tone-a.wav",
    title: "Tone A",
    codec: "PCM",
    lossless: true,
    durationMs: 3000,
    frequency: 440,
  },
  {
    file: "tone-b.wav",
    title: "Tone B",
    codec: "PCM",
    lossless: true,
    durationMs: 3000,
    frequency: 660,
  },
  {
    file: "tone-c.flac",
    title: "Tone C",
    codec: "FLAC",
    lossless: true,
    durationMs: 3000,
    frequency: 550,
  },
  {
    file: "tone-d.mp3",
    title: "Tone D",
    codec: "MPEG 1 Layer 3",
    lossless: false,
    durationMs: 3000,
    frequency: 330,
  },
  {
    file: "tone-e.opus",
    title: "Tone E",
    codec: "Opus",
    lossless: false,
    durationMs: 3000,
    frequency: 770,
  },
];

/** Songs for the session and handoff tests: long enough to hand off mid-song. */
export const sessionFixtures: ReadonlyArray<Fixture> = [
  {
    file: "song-1.flac",
    title: "Song One",
    codec: "FLAC",
    lossless: true,
    durationMs: 90_000,
    frequency: 440,
  },
  {
    file: "song-2.mp3",
    title: "Song Two",
    codec: "MPEG 1 Layer 3",
    lossless: false,
    durationMs: 90_000,
    frequency: 550,
  },
  {
    file: "song-3.opus",
    title: "Song Three",
    codec: "Opus",
    lossless: false,
    durationMs: 90_000,
    frequency: 660,
  },
];

/** Writes every fixture that does not exist yet. Needs `ffmpeg` on PATH. */
export const generateFixtures = (): void => {
  mkdirSync(fixturesDir, { recursive: true });

  for (const fixture of [...engineFixtures, ...sessionFixtures]) {
    const target = join(fixturesDir, fixture.file);

    if (existsSync(target)) continue;
    const extension = fixture.file.slice(fixture.file.lastIndexOf(".") + 1);
    const seconds = fixture.durationMs / 1000;

    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${fixture.frequency}:sample_rate=48000:duration=${seconds}`,
      "-ac",
      "2",
      ...(encoders.get(extension) ?? []),
      target,
    ]);
  }
};
