/**
 * Music's byte responses, as old music's media service answered them (`file-response.ts` and
 * `transcoded-response.ts`), on Effect's HTTP server: a file with byte ranges and validators, a
 * transcode streamed as ffmpeg writes it, the finished transcode a client polls for, and a fresh
 * encode from an offset. Each stops mid-body once the session that admitted its ticket ends
 * (ADR 0011).
 */
import { MusicStreamTimingHeader } from "@media/contracts/music-playback";
import { Duration, Effect, FileSystem, Option, Schema, type Scope, Stream } from "effect";
import { HttpEffect, type HttpServerRequest, HttpServerResponse } from "effect/http";

import { ByteRange, parseByteRange } from "../http/byte-range.ts";
import { isFragmentedProfile } from "./ffmpeg-args.ts";
import * as Files from "./music-files.ts";
import { estimatedTimingHeaders, timingHeaders } from "./sample-timing.ts";
import * as MusicTranscoder from "./transcoder.ts";
import { Opened, Prepared } from "./transcoder.ts";
import type { Transcoded, TranscodeInput } from "./transcoder.ts";

/** `Cache-Control` for audio streams: private to the listener, reusable for an hour. */
const STREAM_CACHE_CONTROL = "private, max-age=3600";

const READ_CHUNK = 256 * 1024;

/** A byte response stopped because the session that admitted it ended. */
class SessionEndedMidResponse extends Schema.TaggedError<SessionEndedMidResponse>()(
  "SessionEndedMidResponse",
  {},
) {}

/**
 * `body`, failing once `sessionEnded` completes, which aborts the response (ADR 0011). Without a
 * session to follow, `body` as it is.
 */
const untilSessionEnds = <E>(
  body: Stream.Stream<Uint8Array, E>,
  sessionEnded: Effect.Effect<void> | undefined,
): Stream.Stream<Uint8Array, E | SessionEndedMidResponse> =>
  sessionEnded === undefined
    ? body
    : body.pipe(
        Stream.interruptWhen(sessionEnded.pipe(Effect.andThen(new SessionEndedMidResponse()))),
      );

/** How a file response describes its body. */
interface FileResponseOptions {
  readonly contentType: string;
  /** Extra headers sent with every status, such as stream timing. */
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly sessionEnded: Effect.Effect<void> | undefined;
}

/**
 * The version of a file's bytes, its size and change time in base 36 in quotes, as old music's
 * `ETag` and the core's track download revision name it, so a device resumes with `If-Range`.
 */
const etagOf = (size: number, mtimeMs: number): string =>
  `"${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}"`;

/** Headers as Node sends them, by lowercase name. */
const lowercased = (
  headers: ReadonlyArray<readonly [string, string]>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value]));

const matchesEtag = (header: string, etag: string): boolean =>
  header.trim() === "*" ||
  header.split(",").some((candidate) => candidate.trim().replace(/^W\//u, "") === etag);

/**
 * Answers `request` with the file at `path`: `304` for a matching `If-None-Match`, `206` for a
 * byte range (honoured only when `If-Range` matches), `416` past the end, and the whole file
 * otherwise, with `ETag`, `Last-Modified`, and `Accept-Ranges`. Fails with `FileError` when the
 * file cannot be read; a missing one has `missing: true`.
 */
export const fileResponse = Effect.fn("MusicResponses.file")(function* (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  options: FileResponseOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Files.statPath(path);

  if (info.kind !== "file") {
    return yield* new Files.FileError({ operation: "serve", path, missing: true, cause: null });
  }

  const { size, mtimeMs } = info;
  const etag = etagOf(size, mtimeMs);
  const lastModified = new Date(Math.trunc(mtimeMs)).toUTCString();

  const headers = {
    "accept-ranges": "bytes",
    "cache-control": STREAM_CACHE_CONTROL,
    "content-type": options.contentType,
    etag,
    "last-modified": lastModified,
    ...lowercased(options.headers ?? []),
  };

  const ifNoneMatch = request.headers["if-none-match"];

  if (ifNoneMatch !== undefined && matchesEtag(ifNoneMatch, etag)) {
    return HttpServerResponse.empty({ status: 304, headers });
  }

  const ifRange = request.headers["if-range"];
  const rangeAllowed = ifRange === undefined || ifRange === etag || ifRange === lastModified;
  const range = parseByteRange(rangeAllowed ? request.headers["range"] : undefined, size);

  const body = (status: number, offset: number, bytes: number, more: Record<string, string>) =>
    HttpServerResponse.stream(
      untilSessionEnds(
        bytes === 0
          ? Stream.empty
          : fs.stream(path, { offset, bytesToRead: bytes, chunkSize: READ_CHUNK }),
        options.sessionEnded,
      ),
      {
        status,
        headers: { ...headers, ...more, "content-length": String(bytes) },
        contentType: options.contentType,
        contentLength: bytes,
      },
    );

  return ByteRange.$match(range, {
    Full: () => body(200, 0, size, {}),
    Partial: ({ start, end }) =>
      body(206, start, end - start + 1, { "content-range": `bytes ${start}-${end}/${size}` }),
    Unsatisfiable: () =>
      HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` },
      }),
  });
});

const OPENING_RANGE = /^bytes=0-1?$/u;

/** A plain `GET` of the whole stream, which a live transcode can answer. */
const wantsWholeStream = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const range = request.headers["range"];

  return (
    request.method === "GET" &&
    (range === undefined || OPENING_RANGE.test(range.trim())) &&
    request.headers["if-range"] === undefined &&
    request.headers["if-none-match"] === undefined
  );
};

const finishedFile = (
  request: HttpServerRequest.HttpServerRequest,
  { path, timing }: Transcoded,
  sessionEnded: Effect.Effect<void> | undefined,
) =>
  fileResponse(request, path, {
    contentType: "audio/mp4",
    headers: Option.match(timing, { onNone: () => [], onSome: timingHeaders }),
    sessionEnded,
  });

const liveResponse = (
  input: TranscodeInput,
  bytes: Stream.Stream<Uint8Array, MusicTranscoder.TranscodeError>,
  timing: ReadonlyArray<readonly [string, string]>,
  sessionEnded: Effect.Effect<void> | undefined,
) =>
  HttpEffect.scopeTransferToStream(
    HttpServerResponse.stream(
      untilSessionEnds(
        bytes.pipe(
          Stream.tapError((error) => Effect.logError("MusicResponses.live_failed", error)),
        ),
        sessionEnded,
      ),
      {
        headers: {
          "cache-control": "no-store",
          ...lowercased(timing),
        },
        contentType: isFragmentedProfile(input.profile) ? "audio/mp4" : "audio/aac",
      },
    ),
  );

/**
 * Answers `request` with the transcode of `input`. A `GET` for the whole stream while it is still
 * being transcoded gets a `200` streamed as ffmpeg writes it, with no `Content-Length`, no `ETag`,
 * and `Cache-Control: no-store`: fragmented profiles as `audio/mp4` with estimated timing headers
 * (`MusicStreamTimingHeader.estimated`), AAC profiles as ADTS (`audio/aac`). A failure after the
 * first byte aborts the response. Other requests wait for the finished file. The live stream holds
 * the transcode in the request's scope until its body ends.
 *
 * @returns The response, or `TranscodeError` when the transcode fails before its first byte, or
 *   `FileError` when the finished file cannot be read.
 */
export const transcodedResponse = Effect.fn("MusicResponses.transcoded")(function* (
  request: HttpServerRequest.HttpServerRequest,
  input: TranscodeInput,
  sessionEnded: Effect.Effect<void> | undefined,
): Effect.fn.Return<
  HttpServerResponse.HttpServerResponse,
  MusicTranscoder.TranscodeError | Files.FileError,
  MusicTranscoder.Service | FileSystem.FileSystem | Scope.Scope
> {
  const transcoder = yield* MusicTranscoder.Service;

  if (!wantsWholeStream(request)) {
    return yield* finishedFile(request, yield* transcoder.transcode(input), sessionEnded);
  }

  const opened = yield* transcoder.open(input);

  return yield* Opened.$match(opened, {
    Finished: ({ transcoded }) => finishedFile(request, transcoded, sessionEnded),
    Live: ({ timing, bytes }) =>
      Effect.succeed(
        liveResponse(
          input,
          bytes,
          Option.match(timing, { onNone: () => [], onSome: estimatedTimingHeaders }),
          sessionEnded,
        ),
      ),
  });
});

/**
 * Answers a request for the finished transcode of `input` (`&finished=1`, `GET` or `HEAD`): the
 * cached file with `Content-Length`, `ETag`, and byte ranges. While the transcode is prepared in
 * the background, it answers `503` with `Retry-After` and `Cache-Control: no-store` instead, so a
 * client polls rather than holding a connection through the encode, and leaving does not stop it.
 *
 * @returns The response, or `TranscodeError` when the background transcode failed just now, or
 *   `FileError` when the finished file cannot be read.
 */
export const finishedResponse = Effect.fn("MusicResponses.finished")(function* (
  request: HttpServerRequest.HttpServerRequest,
  input: TranscodeInput,
  sessionEnded: Effect.Effect<void> | undefined,
) {
  const transcoder = yield* MusicTranscoder.Service;
  const prepared = yield* transcoder.prepare(input);

  return yield* Prepared.$match(prepared, {
    Ready: ({ transcoded }) => finishedFile(request, transcoded, sessionEnded),
    Pending: ({ retryAfter }) =>
      Effect.succeed(
        HttpServerResponse.text("Preparing the file; retry shortly", {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "retry-after": String(Math.ceil(Duration.toSeconds(retryAfter))),
          },
        }),
      ),
    Failed: ({ error }) => Effect.fail(error),
  });
});

/**
 * Answers a request for the transcode of `input` from `startMs` into the song (`&start=` on a
 * transcoded profile) with a fresh encode from that point, whatever the cache holds: a `200`
 * streamed like a live transcode, with `X-Music-Start-Samples`, `X-Music-Priming-Samples`, and
 * `X-Music-Sample-Rate`, plus an estimated `X-Music-Duration-Samples` for the fragmented profiles.
 * Ranges and validators do not apply. ffmpeg stops when the client goes away.
 *
 * @returns The response, or `TranscodeError` when ffmpeg fails before its first byte, or
 *   `OffsetRunsBusy` when every offset run is taken.
 */
export const offsetResponse = Effect.fn("MusicResponses.offset")(function* (
  input: TranscodeInput,
  startMs: number,
  sessionEnded: Effect.Effect<void> | undefined,
) {
  const transcoder = yield* MusicTranscoder.Service;
  const opened = yield* transcoder.openAt(input, startMs);

  return liveResponse(
    input,
    opened.bytes,
    [
      [MusicStreamTimingHeader.start, String(opened.startSamples)],
      [MusicStreamTimingHeader.priming, String(opened.primingSamples)],
      [MusicStreamTimingHeader.sampleRate, String(opened.sampleRate)],
      ...Option.match(opened.durationSamples, {
        onNone: () => [],
        onSome: (samples) => [
          [MusicStreamTimingHeader.duration, String(samples)] as const,
          [MusicStreamTimingHeader.estimated, "1"] as const,
        ],
      }),
    ],
    sessionEnded,
  );
});
