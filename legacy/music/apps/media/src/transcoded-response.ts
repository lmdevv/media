/**
 * The HTTP response for a transcoded stream profile. A fragmented profile that is not in the
 * cache yet streams while ffmpeg writes it: playback starts after the first fragment instead of
 * after the whole encode. Everything else is served from the finished file, with byte ranges.
 */
import { Effect, Exit, Option, Scope, Stream } from "effect";

import { isFragmentedProfile } from "./ffmpeg.ts";
import { fileResponse, STREAM_CACHE_CONTROL } from "./file-response.ts";
import { estimatedTimingHeaders, timingHeaders } from "./sample-timing.ts";
import { Opened, Transcoder, type TranscodeInput } from "./transcoder.ts";

/**
 * True for a request a live transcode can answer: a plain `GET` from the start. Ranges and
 * validators refer to the finished file, whose bytes differ (it has a `sidx` index), and `HEAD`
 * asks for the exact timing, so those wait for the transcode to finish.
 */
const wantsWholeStream = (request: Request): boolean =>
  request.method === "GET" &&
  ["Range", "If-Range", "If-None-Match"].every((name) => !request.headers.has(name));

/**
 * Answers `request` with the transcode of `input`. A plain `GET` for a fragmented profile that
 * is still being transcoded gets a `200` streamed as ffmpeg writes it, with estimated timing
 * headers (see `StreamTimingHeader.estimated`), no `ETag`, and `Cache-Control: no-store`; a
 * failure after the first byte aborts the response. Other requests wait for the finished file.
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

  if (!isFragmentedProfile(input.profile) || !wantsWholeStream(request)) {
    return yield* serveFinished();
  }

  // Holds the live transcode for as long as the response body streams it.
  const scope = yield* Scope.make();
  const context = yield* Effect.context();

  const opened = yield* transcoder.open(input).pipe(
    Scope.provide(scope),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );

  return yield* Opened.$match(opened, {
    Finished: () => Scope.close(scope, Exit.void).pipe(Effect.andThen(serveFinished())),
    Live: ({ timing, bytes }) => {
      const body = bytes.pipe(
        Stream.tapError((error) => Effect.logError("TranscodedResponse.live_failed", error)),
        Stream.ensuring(Scope.close(scope, Exit.void)),
        Stream.toReadableStreamWith(context),
      );

      const headers = new Headers({ "Content-Type": "audio/mp4", "Cache-Control": "no-store" });

      for (const [name, value] of estimatedTimingHeaders(timing)) headers.set(name, value);

      return Effect.succeed(new Response(body, { status: 200, headers }));
    },
  });
});
