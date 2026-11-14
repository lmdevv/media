/**
 * Music's two ways of running ffmpeg with its stream on `pipe:3`, as old music's media service ran
 * them (`ffmpeg.ts`), on the server's tools: they start through `MediaTools`, so each run dies
 * with the server and sees only the tools' environment (ADR 0014).
 */
import { Effect, Stream } from "effect";

import type * as MediaTools from "../media/media-tools.ts";
import { MediaToolFailed } from "../media/media-tools.ts";

const readFailed = (cause: unknown) =>
  new MediaToolFailed({ tool: "ffmpeg", exitCode: null, stderr: "", cause });

/**
 * Runs ffmpeg to completion while handing each chunk it writes to `pipe:3` to `onChunk`, in order
 * and one at a time; ffmpeg waits while `onChunk` runs. `onStdout` gets standard output piece by
 * piece. Fails with the first `onChunk` failure, which kills ffmpeg, or with `MediaToolFailed`.
 */
export const runPiped = <E, R>(
  tools: MediaTools.Interface,
  args: ReadonlyArray<string>,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void, E, R>,
  onStdout?: (text: string) => void,
): Effect.Effect<void, MediaToolFailed | E, R> =>
  Effect.gen(function* () {
    const piped = yield* tools.startFfmpegPiped(args, onStdout);

    yield* Effect.all(
      [
        Stream.fromAsyncIterable(piped.output, readFailed).pipe(Stream.runForEach(onChunk)),
        piped.exit,
      ],
      { concurrency: 2, discard: true },
    );
  }).pipe(Effect.scoped);

/**
 * Runs ffmpeg and streams what it writes to `pipe:3`. ffmpeg waits while nobody pulls, and is
 * killed when the stream is no longer consumed. Fails with `MediaToolFailed` when it cannot start,
 * or exits unsuccessfully after its last byte.
 */
export const streamPiped = (
  tools: MediaTools.Interface,
  args: ReadonlyArray<string>,
): Stream.Stream<Uint8Array, MediaToolFailed> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const piped = yield* tools.startFfmpegPiped(args);

      return Stream.fromAsyncIterable(piped.output, readFailed).pipe(
        Stream.concat(Stream.fromEffectDrain(piped.exit)),
      );
    }),
  );
