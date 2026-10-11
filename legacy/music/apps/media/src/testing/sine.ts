/**
 * A continuous sine cut into pieces at sample positions, for gapless tests: played back to back,
 * the pieces must rebuild the unbroken tone, so any trimming error shows up as a discontinuity.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Effect } from "effect";

import { runTool } from "../ffmpeg.ts";
import * as Files from "../files.ts";

/** Sample rate of the generated tone. */
const SINE_RATE = 48_000;

/** The tone: 110 Hz at half scale, identical in both channels. */
const TONE = "aevalsrc=0.5*sin(2*PI*110*t)|0.5*sin(2*PI*110*t)";

/** Encoders by file extension. */
const ENCODERS: Readonly<Record<"flac" | "mp3" | "m4a", ReadonlyArray<string>>> = {
  flac: ["-c:a", "flac"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "192k"],
  m4a: ["-c:a", "aac", "-b:a", "192k"],
};

/** Writes samples `[start, end)` of the tone to `dir/name.extension`; returns the path. */
export const sineSegment = (
  dir: string,
  name: string,
  extension: keyof typeof ENCODERS,
  start: number,
  end: number,
) => {
  const path = join(dir, `${name}.${extension}`);

  return runTool("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${TONE}:s=${SINE_RATE}:d=${Math.ceil(end / SINE_RATE) + 1}`,
    "-af",
    `atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB`,
    ...ENCODERS[extension],
    path,
  ]).pipe(Effect.as(path));
};

/** Decodes the first audio stream of `path` to mono 32-bit float samples, without any trimming. */
export const decodeMono = Effect.fn("Test.decodeMono")(function* (path: string, scratch: string) {
  const raw = join(scratch, `decoded-${randomUUID()}.f32`);
  yield* runTool("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-f",
    "f32le",
    raw,
  ]);
  const bytes = yield* Files.readWholeFile(raw);

  // `slice` copies into a fresh, aligned buffer.
  return new Float32Array(bytes.slice().buffer);
});
