/**
 * Short generated audio files for the browser tests. Sine tones have no silence of their own, so
 * any silence in the captured output is a gap the player introduced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Sample rate of the gapless tone. */
export const GAPLESS_RATE = 48_000;

/** Frequency of the gapless tone, in Hz. */
export const GAPLESS_FREQUENCY = 110;

/**
 * Where the continuous gapless tone is cut into three songs, in samples. The cuts sit off every
 * codec's frame grid (1024, 1152, 4096), so only exact priming and padding trims rebuild it.
 */
export const GAPLESS_CUTS: ReadonlyArray<number> = [0, 150_001, 306_337, 432_000];

/** Source codecs the gapless tone is encoded in. */
export type GaplessSource = "flac" | "mp3" | "m4a";

/** File name of one part (1 to 3) of the gapless tone in one source codec. */
export const gaplessFile = (source: GaplessSource, part: number): string =>
  `gapless-${source}-${part}.${source}`;

const gaplessEncoders: Readonly<Record<GaplessSource, ReadonlyArray<string>>> = {
  flac: ["-c:a", "flac"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "192k"],
  m4a: ["-c:a", "aac", "-b:a", "192k"],
};

/**
 * Real length of the first audio stream of `path`, in samples: ffmpeg's decoded frame count, or
 * for an `.m4a` its edit list length (ffmpeg 6 decodes AAC in MP4 with its end padding).
 */
const realSamples = (path: string): number => {
  if (path.endsWith(".m4a")) {
    return Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=duration_ts",
          "-of",
          "csv=p=0",
          path,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
  }

  return execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "framecrc", "-"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce((total, line) => total + Number(line.split(",")[3]), 0);
};

/**
 * Cuts one continuous sine into three parts per source codec. Each part must decode to exactly
 * its length, or measurements would blame the player for an encoder's padding: ffmpeg's MP3
 * muxer writes a wrong LAME padding value for some lengths (144017 samples decodes to 144047),
 * and the cuts above avoid them.
 */
const generateGapless = (): void => {
  for (const source of ["flac", "mp3", "m4a"] as const) {
    for (let part = 1; part < GAPLESS_CUTS.length; part += 1) {
      const target = join(fixturesDir, gaplessFile(source, part));

      if (existsSync(target)) continue;
      const start = GAPLESS_CUTS[part - 1] ?? 0;
      const end = GAPLESS_CUTS[part] ?? 0;
      const tone = `0.5*sin(2*PI*${GAPLESS_FREQUENCY}*t)`;

      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${tone}|${tone}:s=${GAPLESS_RATE}:d=10`,
        "-af",
        `atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB`,
        ...gaplessEncoders[source],
        target,
      ]);

      const length = realSamples(target);

      if (length !== end - start) {
        rmSync(target);

        throw new Error(`${target} decodes to ${length} samples, not ${end - start}`);
      }
    }
  }
};

/**
 * One minute of 24-bit 96 kHz stereo noise, which FLAC cannot compress (about 4.6 Mbit/s): more
 * than the buffer quota of some browsers holds in the engine's look-ahead.
 */
export const HIRES_FIXTURE = "hires-noise.flac";

const generateHires = (): void => {
  const target = join(fixturesDir, HIRES_FIXTURE);

  if (existsSync(target)) return;

  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=white:amplitude=0.3:sample_rate=96000:duration=60",
    "-ac",
    "2",
    "-c:a",
    "flac",
    "-sample_fmt",
    "s32",
    "-bits_per_raw_sample",
    "24",
    target,
  ]);
};

/**
 * An MP3 cut off half-way through: its header still declares two minutes, which the media service
 * takes as the estimated length of a live transcode, but only one minute of audio decodes.
 */
export const TRUNCATED_FIXTURE = "truncated.mp3";

/** The length `TRUNCATED_FIXTURE` declares. */
export const TRUNCATED_DECLARED_MS = 120_000;

/** The length of the audio in `TRUNCATED_FIXTURE`, give or take a frame. */
export const TRUNCATED_REAL_MS = 60_000;

const generateTruncated = (): void => {
  const target = join(fixturesDir, TRUNCATED_FIXTURE);

  if (existsSync(target)) return;
  const whole = `${target}.whole.mp3`;

  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${TRUNCATED_DECLARED_MS / 1000}`,
    "-ac",
    "2",
    ...(encoders.get("mp3") ?? []),
    whole,
  ]);

  // A constant bitrate: half the bytes hold half the audio. The Xing header still counts all of it.
  const bytes = readFileSync(whole);

  writeFileSync(
    target,
    bytes.subarray(0, Math.round((bytes.length * TRUNCATED_REAL_MS) / TRUNCATED_DECLARED_MS)),
  );
  rmSync(whole);
};

/** Writes every fixture that does not exist yet. Needs `ffmpeg` on PATH. */
export const generateFixtures = (): void => {
  mkdirSync(fixturesDir, { recursive: true });
  generateGapless();
  generateHires();
  generateTruncated();

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
