/** Runs ffmpeg and ffprobe. Process spawning lives in `platform/node-process.ts`. */
import type { StreamProfile } from "@music/commands/models";
import { Effect, Schema } from "effect";

import { type ProcessResult, runProcess } from "./platform/node-process.ts";

/** A media tool could not start, or exited unsuccessfully. */
export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Finite),
  /** Tail of the tool's standard error, which names files but never secrets. */
  stderr: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media tool failed: ${this.command} exited with ${String(this.exitCode)}: ${this.stderr.trim().slice(-300)}`;
  }
}

/**
 * Runs a tool to completion; interruption kills it. Fails with `ProcessError` when it cannot
 * start or exits with a non-zero code.
 */
export const runTool = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<ProcessResult, ProcessError> =>
  Effect.tryPromise({
    try: (signal) => runProcess(command, args, signal),
    catch: (cause) => new ProcessError({ command, exitCode: null, stderr: "", cause }),
  }).pipe(
    Effect.filterOrFail(
      (result) => result.exitCode === 0,
      (result) =>
        new ProcessError({
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
          cause: null,
        }),
    ),
  );

/** Transcode profiles, by AAC bitrate. */
export type TranscodeProfile = Exclude<StreamProfile, "original">;

const BITRATES: Record<TranscodeProfile, string> = { "aac-320": "320k", "aac-128": "128k" };

/**
 * ffmpeg arguments that transcode the first audio stream of `source` to stereo 44.1 kHz AAC in a
 * fast-start MP4 (`.m4a`) at `destination`, keeping tags and dropping cover art streams.
 */
export const transcodeArgs = (
  source: string,
  destination: string,
  profile: TranscodeProfile,
): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-y",
  "-i",
  source,
  "-map",
  "0:a:0",
  "-c:a",
  "aac",
  "-b:a",
  BITRATES[profile],
  "-ar",
  "44100",
  "-ac",
  "2",
  "-map_metadata",
  "0",
  "-movflags",
  "+faststart",
  "-f",
  "mp4",
  destination,
];
