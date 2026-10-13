/**
 * The HTTP response for a transcoded stream profile. A profile that is not in the cache yet
 * streams while ffmpeg writes it: playback starts after the first frames instead of after the
 * whole encode. Everything else is served from the finished file, with byte ranges.
 */
import { StreamTimingHeader } from "@music/commands/models";
import { type Context, Effect, Exit, Option, Scope, Stream } from "effect";

import { isFragmentedProfile } from "./ffmpeg.ts";
import { fileResponse, STREAM_CACHE_CONTROL } from "./file-response.ts";
import { estimatedTimingHeaders, timingHeaders } from "./sample-timing.ts";
import { Opened, type TranscodeError, Transcoder, type TranscodeInput } from "./transcoder.ts";

/**
 * The ranges a media element opens a source with: `bytes=0-` (Chromium, Firefox) and Safari's
 * probe `bytes=0-1`. Other ranges want the finished file's bytes at those offsets.
 */
const OPENING_RANGE = /^bytes=0-1?$/u;

/**
 * True for a request a live transcode can answer: a `GET` without validators, for the whole
 * stream or with a media element's opening range. The element takes the `200` without
 * `Accept-Ranges` as a stream it cannot seek in by bytes. Other ranges and validators refer to
 * the finished file, whose bytes differ, and `HEAD` asks for the finished file's headers (the
 * exact timing), so those wait for the transcode to finish.
 */
const wantsWholeStream = (request: Request): boolean => {
  const range = request.headers.get("Range");

  return (
    request.method === "GET" &&
    (range === null || OPENING_RANGE.test(range.trim())) &&
    ["If-Range", "If-None-Match"].every((name) => !request.headers.has(name))
  );
};

/**
 * Answers `request` with the transcode of `input`. A `GET` for the whole stream while it is
 * still being transcoded gets a `200` streamed as ffmpeg writes it, with no `Content-Length`, no
 * `ETag`, and `Cache-Control: no-store`: fragmented profiles as `audio/mp4` with estimated timing
 * headers (see `StreamTimingHeader.estimated`), AAC profiles as ADTS (`audio/aac`). A failure
 * after the first byte aborts the response. Other requests wait for the finished file.
 *
 * @returns The response, or `TranscodeError` when the transcode fails before its first byte, or
 *   `FileError` when the finished file cannot be read.
 */
export const transcodedResponse = Effect.fn("TranscodedResponse.make")(function* (
  request: Request,
  input: TranscodeInput,
) {
  const transcoder = yield* Transcoder;

  const serveFinished = Effect.fn("TranscodedResponse.serveFinished")(function* () {
    const { path, timing } = yield* transcoder.transcode(input);

    return yield* fileResponse(request, path, {
      contentType: "audio/mp4",
      cacheControl: STREAM_CACHE_CONTROL,
      headers: Option.match(timing, { onNone: () => [], onSome: timingHeaders }),
    });
  });

  if (!wantsWholeStream(request)) return yield* serveFinished();

  const context = yield* Effect.context();
  // Holds the live transcode for as long as the response body streams it.
  const scope = yield* Scope.make();

  // Until the response owns the scope, a failure or an interruption (the client went away)
  // closes it here.
  return yield* transcoder.open(input).pipe(
    Scope.provide(scope),
    Effect.flatMap(
      Opened.$match({
        Finished: () => Scope.close(scope, Exit.void).pipe(Effect.andThen(serveFinished())),
        Live: ({ timing, bytes }) =>
          streamedResponse(
            request,
            input,
            bytes,
            scope,
            context,
            Option.match(timing, { onNone: () => [], onSome: estimatedTimingHeaders }),
          ),
      }),
    ),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );
});

/**
 * Closes `scope` once the client behind `signal` goes away. The response body closes it when it
 * ends or is cancelled, but `@hono/node-server` neither reads nor cancels the body of a client
 * that left before the body started streaming, so the body alone would hold the scope forever.
 * Closing an already closed scope does nothing, so the scope still closes exactly once.
 */
const closeWhenAborted = (signal: AbortSignal, scope: Scope.Closeable): Effect.Effect<void> => {
  if (signal.aborted) return Scope.close(scope, Exit.void);

  const abort = () => {
    Effect.runFork(Scope.close(scope, Exit.void));
  };

  signal.addEventListener("abort", abort, { once: true });

  return Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      signal.removeEventListener("abort", abort);
    }),
  );
};

/**
 * A `200` that streams `bytes` with `Cache-Control: no-store` and no length, and closes `scope`
 * once the body ends or the client goes away. A failure after the first byte aborts it.
 */
const streamedResponse = (
  request: Request,
  input: TranscodeInput,
  bytes: Stream.Stream<Uint8Array, TranscodeError>,
  scope: Scope.Closeable,
  context: Context.Context<never>,
  timing: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<Response> =>
  closeWhenAborted(request.signal, scope).pipe(
    Effect.map(() => {
      const body = bytes.pipe(
        // Once the client has gone, closing the scope may stop ffmpeg under a read: not a failure.
        Stream.tapError((error) =>
          request.signal.aborted
            ? Effect.void
            : Effect.logError("TranscodedResponse.live_failed", error),
        ),
        Stream.ensuring(Scope.close(scope, Exit.void)),
        Stream.toReadableStreamWith(context),
      );

      const headers = new Headers({
        "Content-Type": isFragmentedProfile(input.profile) ? "audio/mp4" : "audio/aac",
        "Cache-Control": "no-store",
      });

      for (const [name, value] of timing) headers.set(name, value);

      return new Response(body, { status: 200, headers });
    }),
  );

/**
 * Answers a request for the transcode of `input` from `startMs` into the song (`&start=` on a
 * transcoded profile) with a fresh encode from that point, whatever the cache holds: a `200`
 * streamed like a live transcode (see `transcodedResponse`), with `X-Music-Start-Samples`,
 * `X-Music-Priming-Samples`, and `X-Music-Sample-Rate`, plus an estimated
 * `X-Music-Duration-Samples` for the fragmented profiles (see `FromOffset` for the timeline).
 * Ranges and validators do not apply. ffmpeg stops when the client goes away.
 *
 * @returns The response, or `TranscodeError` when ffmpeg fails before its first byte.
 */
export const offsetResponse = Effect.fn("TranscodedResponse.offset")(function* (
  request: Request,
  input: TranscodeInput,
  startMs: number,
) {
  const transcoder = yield* Transcoder;
  const context = yield* Effect.context();
  // Holds the ffmpeg run for as long as the response body streams it.
  const scope = yield* Scope.make();

  // Until the response owns the scope, a failure or an interruption (the client went away)
  // closes it here.
  return yield* transcoder.openAt(input, startMs).pipe(
    Scope.provide(scope),
    Effect.flatMap((opened) =>
      streamedResponse(request, input, opened.bytes, scope, context, [
        [StreamTimingHeader.start, String(opened.startSamples)],
        [StreamTimingHeader.priming, String(opened.primingSamples)],
        [StreamTimingHeader.sampleRate, String(opened.sampleRate)],
        ...Option.match(opened.durationSamples, {
          onNone: () => [],
          onSome: (samples) => [
            [StreamTimingHeader.duration, String(samples)] as const,
            [StreamTimingHeader.estimated, "1"] as const,
          ],
        }),
      ]),
    ),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );
});
