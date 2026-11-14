import type { MediaFileId } from "@media/contracts/ids";
import {
  type Container,
  FileResolverUnavailable,
  MediaFileNotFound,
  PlaybackSessionEnded,
  PlaybackTokenInvalid,
  SegmentNotFound,
  SegmentNotReady,
  StreamAccessDenied,
  StreamGenerationGone,
  StreamId,
  StreamNotFound,
  TranscodeFailed,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpEffect,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { grantAnnotations, LogEvent, SLOW_MS } from "../diagnostics/log-events.ts";
import * as Downloads from "../downloads/downloads.ts";
import * as MediaConfig from "../media-config.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { renderPlaylist } from "../playback/hls-plan.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import * as SubtitleConverter from "../subtitles/subtitle-tracks.ts";
import {
  SubtitleConversionFailed,
  SubtitleTrackNotFound,
  SubtitleUnsupported,
} from "../subtitles/subtitle-tracks.ts";
import { ByteRange, parseByteRange } from "./byte-range.ts";
import { type FailureBudget, type FailureKind, makeFailureBudget } from "./failure-budget.ts";

class MediaAccessDenied extends Schema.TaggedError<MediaAccessDenied>()(
  "MediaAccessDenied",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Media access denied: the token is for another file";
  }
}

class MediaFileUnreadable extends Schema.TaggedError<MediaFileUnreadable>()(
  "MediaFileUnreadable",
  {},
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return "Media file unreadable: the library may be offline";
  }
}

const RouteError = Schema.Union([
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  MediaAccessDenied,
  MediaFileNotFound,
  MediaFileUnreadable,
  FileResolverUnavailable,
  StreamNotFound,
  StreamAccessDenied,
  StreamGenerationGone,
  SegmentNotFound,
  SegmentNotReady,
  TranscodeFailed,
  UnsupportedPlayback,
  SubtitleTrackNotFound,
  SubtitleUnsupported,
  SubtitleConversionFailed,
]);

type RouteError = typeof RouteError.Type;

const encodeRouteError = Schema.encodeEffect(Schema.toCodecJson(RouteError));

const statusOf = Match.valueTags<RouteError, Record<RouteError["_tag"], () => number>>({
  PlaybackTokenInvalid: () => 401,
  PlaybackSessionEnded: () => 410,
  MediaAccessDenied: () => 403,
  MediaFileNotFound: () => 404,
  MediaFileUnreadable: () => 503,
  FileResolverUnavailable: () => 503,
  StreamNotFound: () => 404,
  StreamAccessDenied: () => 403,
  StreamGenerationGone: () => 410,
  SegmentNotFound: () => 404,
  SegmentNotReady: () => 503,
  TranscodeFailed: () => 500,
  UnsupportedPlayback: () => 422,
  SubtitleTrackNotFound: () => 404,
  SubtitleUnsupported: () => 415,
  SubtitleConversionFailed: () => 500,
});

const errorResponse = (error: RouteError) =>
  encodeRouteError(error).pipe(
    Effect.orDie,
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(body, {
        status: statusOf(error),
        headers: { "cache-control": "no-store" },
      }),
    ),
  );

const CONTENT_TYPES: Readonly<Record<Container, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  other: "application/octet-stream",
};

const SEGMENT_CACHE = "private, max-age=3600";

/** How long a request waits for the library's disk, which a hung network share never answers. */
const FILE_WAIT = Duration.seconds(30);

/** A byte response stopped because the session that admitted it ended. */
class SessionEndedMidResponse extends Schema.TaggedError<SessionEndedMidResponse>()(
  "SessionEndedMidResponse",
  {},
) {}

const withinFileWait = <A, E, R>(waiting: Effect.Effect<A, E, R>) =>
  waiting.pipe(
    Effect.timeoutOrElse({
      duration: FILE_WAIT,
      orElse: () => Effect.fail(new MediaFileUnreadable()),
    }),
  );

const READ_CHUNK = 256 * 1024;

const readWhole = (handle: FileSystem.File, size: number, readMs: Ref.Ref<number>) =>
  Stream.paginate(0, (position: number) =>
    handle.readAlloc(Math.min(READ_CHUNK, size - position), { position: BigInt(position) }).pipe(
      Effect.timed,
      Effect.tap(([elapsed]) => Ref.update(readMs, (total) => total + Duration.toMillis(elapsed))),
      Effect.map(([, chunk]) => {
        const bytes = Option.getOrElse(chunk, () => new Uint8Array(0));
        const next = position + bytes.length;

        return [
          bytes.length === 0 ? [] : [bytes],
          bytes.length === 0 || next >= size ? Option.none<number>() : Option.some(next),
        ] as const;
      }),
    ),
  );

interface Answer {
  readonly response: HttpServerResponse.HttpServerResponse;
  readonly error: Option.Option<RouteError>;
}

type Authorize = (
  token: Redacted.Redacted,
  purposes: ReadonlyArray<PlaybackToken.TokenPurpose>,
  within?: PlaybackToken.Within,
) => Effect.Effect<PlaybackToken.PlaybackGrant, PlaybackTokenInvalid | PlaybackSessionEnded>;

const MAX_LOGGED_PARAM = 64;

const SUPPRESSED_REPORT_INTERVAL = Duration.seconds(30);

const loggedParam = (value: string | undefined): string | null =>
  value === undefined
    ? null
    : value.length > MAX_LOGGED_PARAM
      ? `${value.slice(0, MAX_LOGGED_PARAM)}…`
      : value;

interface FailureLog {
  readonly budget: FailureBudget;
  readonly owners: StreamOwners.Interface;
  readonly tokens: PlaybackToken.Interface;
}

const observed = <R>(
  failures: FailureLog,
  route: string,
  handler: (
    authorize: Authorize,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const sessionForLog = yield* Ref.make(Option.none<PlaybackToken.SignedSession>());
    const failureKind = yield* Ref.make<FailureKind>("failure");
    const params = yield* HttpRouter.params;

    const authorize: Authorize = (token, purposes, within) =>
      failures.tokens.authorize(token, purposes, within).pipe(
        Effect.tap((grant) => Ref.set(sessionForLog, Option.some(grant))),
        Effect.catch((refused: PlaybackToken.TokenRefused) =>
          Effect.all([
            Ref.set(sessionForLog, refused.sessionForLog),
            Ref.set(failureKind, "token-refused"),
          ]).pipe(Effect.andThen(Effect.fail(refused.error))),
        ),
      );

    const answer = yield* handler(authorize).pipe(
      Effect.map((response): Answer => ({ response, error: Option.none() })),
      Effect.catch((error) =>
        errorResponse(error).pipe(
          Effect.map((response): Answer => ({ response, error: Option.some(error) })),
        ),
      ),
    );

    if (answer.response.status >= 400) {
      const afterSessionEnded = Option.exists(
        answer.error,
        Predicate.isTagged("PlaybackSessionEnded"),
      );

      const session = yield* Ref.get(sessionForLog);
      const kind = yield* Ref.get(failureKind);

      const now = yield* Clock.currentTimeMillis;
      const pathStream = loggedParam(params["streamId"]);

      const ownStream =
        pathStream === null ||
        (Option.isSome(session) &&
          (yield* failures.owners.belongsTo(params["streamId"] ?? "", session.value.sessionId)));

      yield* (
        afterSessionEnded
          ? Effect.logDebug(LogEvent.requestAfterSessionEnded)
          : Option.exists(session, (failed) => failures.budget.allow(failed, kind, now))
            ? Effect.logWarning(LogEvent.requestFailed)
            : Effect.logDebug(LogEvent.requestFailed)
      ).pipe(
        Effect.annotateLogs({
          route,
          status: answer.response.status,
          error: Option.getOrNull(Option.map(answer.error, (error) => error.message)),
          elapsedMs: now - started,
          streamId: ownStream ? pathStream : null,
          claimedStreamId: ownStream ? null : pathStream,
          file: loggedParam(params["file"]),
          ...Option.match(session, { onNone: () => ({}), onSome: grantAnnotations }),
        }),
      );
    }

    return answer.response;
  });

const matchesEtag = (header: string, etag: string): boolean =>
  header.trim() === "*" ||
  header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);

/** Adds the routes. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | MediaConfig.Service
  | PlaybackToken.Service
  | FileResolver.Service
  | StreamSessions.Service
  | StreamOwners.Service
  | SubtitleConverter.Service
  | Downloads.Service
  | FileSystem.FileSystem
  | Path.Path
  | HttpPlatform.HttpPlatform
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const sessions = yield* StreamSessions.Service;
    const subtitles = yield* SubtitleConverter.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* MediaConfig.Service;
    const resolver = yield* FileResolver.Service;
    const platform = yield* HttpPlatform.HttpPlatform;
    const downloads = yield* Downloads.Service;
    const budget = makeFailureBudget();

    const failures: FailureLog = {
      budget,
      owners: yield* StreamOwners.Service,
      tokens: yield* PlaybackToken.Service,
    };

    const reportSuppressed = Effect.suspend(() =>
      Effect.forEach(
        budget.drain(),
        ({ sessionId, userId, count }) =>
          Effect.logWarning(LogEvent.requestFailuresSuppressed).pipe(
            Effect.annotateLogs({ sessionId, userId, failures: count }),
          ),
        { discard: true },
      ),
    );

    yield* Effect.forkScoped(
      Effect.repeat(Effect.delay(reportSuppressed, SUPPRESSED_REPORT_INTERVAL), Schedule.forever),
    );

    const resolve = (fileId: MediaFileId, options: { readonly sidecars: boolean }) =>
      resolveInsideRoots(fileId, options).pipe(
        Effect.provideService(FileResolver.Service, resolver),
        Effect.provideService(MediaConfig.Service, config),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const fileResponse = Effect.fnUntraced(
      function* (
        request: HttpServerRequest.HttpServerRequest,
        file: string,
        contentType: string,
        sessionEnded: Effect.Effect<void> | undefined,
      ) {
        const info = yield* fs.stat(file);
        const size = Number(info.size);

        const modified = modifiedAtMs(info);

        const etag = `"${size.toString(36)}-${Math.trunc(modified).toString(36)}"`;
        const lastModified = new Date(modified).toUTCString();

        const headers = {
          "accept-ranges": "bytes",
          "cache-control": SEGMENT_CACHE,
          "content-type": contentType,
          "last-modified": lastModified,
        };

        const ifNoneMatch = request.headers["if-none-match"];

        if (ifNoneMatch !== undefined && matchesEtag(ifNoneMatch, etag)) {
          return HttpServerResponse.empty({ status: 304, headers: { ...headers, etag } });
        }

        const ifRange = request.headers["if-range"];
        const rangeAllowed = ifRange === undefined || ifRange === etag || ifRange === lastModified;
        const range = parseByteRange(rangeAllowed ? request.headers["range"] : undefined, size);

        // A response admitted for a session stops when that session ends, mid-body included
        // (ADR 0011): its bytes stream from the file and fail then, which aborts the response.
        const body = (
          options: { readonly status: number; readonly offset: number; readonly bytes: number },
          bodyHeaders: Readonly<Record<string, string>>,
        ) =>
          sessionEnded === undefined
            ? platform.fileResponse(file, {
                status: options.status,
                offset: options.offset,
                bytesToRead: options.bytes,
                headers: bodyHeaders,
              })
            : Effect.succeed(
                HttpServerResponse.stream(
                  fs
                    .stream(file, {
                      offset: options.offset,
                      bytesToRead: options.bytes,
                      chunkSize: READ_CHUNK,
                    })
                    .pipe(
                      Stream.interruptWhen(
                        sessionEnded.pipe(
                          Effect.andThen(Effect.fail(new SessionEndedMidResponse())),
                        ),
                      ),
                    ),
                  {
                    status: options.status,
                    headers: bodyHeaders,
                    contentType,
                    contentLength: options.bytes,
                  },
                ),
              );

        const response = yield* ByteRange.$match(range, {
          Full: () => body({ status: 200, offset: 0, bytes: size }, headers),
          Partial: ({ start, end }) =>
            body(
              { status: 206, offset: start, bytes: end - start + 1 },
              { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
            ),
          Unsatisfiable: () =>
            Effect.succeed(
              HttpServerResponse.empty({
                status: 416,
                headers: { ...headers, "content-range": `bytes */${size}` },
              }),
            ),
        });

        // The platform adds a weak ETag; `If-Range` needs this strong one.
        return HttpServerResponse.setHeader(response, "etag", etag);
      },
      Effect.mapError(() => new MediaFileUnreadable()),
    );

    const direct = observed(failures, "direct", (authorize) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.method !== "GET" && request.method !== "HEAD") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
        }

        const { fileId = "" } = yield* HttpRouter.params;

        const grant = yield* authorize(
          yield* PlaybackToken.tokenOf(request, failures.tokens.param),
          PlaybackToken.PLAY_OR_DOWNLOAD,
          PlaybackToken.READ,
        );

        if (!PlaybackToken.admitsFile(grant, fileId)) return yield* new MediaAccessDenied();

        return yield* withinFileWait(
          Effect.gen(function* () {
            const file = yield* resolve(grant.fileId, { sidecars: false });

            return yield* fileResponse(
              request,
              file.path,
              CONTENT_TYPES[file.probe.container],
              grant.sessionEnded,
            );
          }),
        );
      }),
    ).pipe(Effect.withSpan("MediaRoutes.direct"));

    const download = observed(failures, "download", (authorize) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.method !== "GET" && request.method !== "HEAD") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
        }

        const { fileId = "", name = "" } = yield* HttpRouter.params;

        const grant = yield* authorize(
          yield* PlaybackToken.tokenOf(request, failures.tokens.param),
          PlaybackToken.DOWNLOAD,
        );

        if (!PlaybackToken.admitsFile(grant, fileId)) return yield* new MediaAccessDenied();

        return yield* withinFileWait(
          Effect.gen(function* () {
            const output = yield* downloads.output(grant.fileId, name);

            if (Option.isNone(output))
              return yield* new MediaFileNotFound({ fileId: grant.fileId });

            return yield* fileResponse(
              request,
              output.value,
              CONTENT_TYPES.mp4,
              grant.sessionEnded,
            );
          }),
        );
      }),
    ).pipe(Effect.withSpan("MediaRoutes.download"));

    const streamParams = Effect.gen(function* () {
      const params = yield* HttpRouter.params;

      const streamId = yield* Schema.decodeUnknownEffect(StreamId)(params["streamId"]).pipe(
        Effect.mapError(() => new StreamNotFound({ streamId: "" })),
      );

      const generation = Number(params["generation"]);

      return {
        streamId,
        generation: Number.isInteger(generation) ? generation : -1,
        file: params["file"] ?? "",
      };
    });

    const playlist = observed(failures, "playlist", (authorize) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { streamId, generation } = yield* streamParams;
        const token = yield* PlaybackToken.tokenOf(request, failures.tokens.param);
        const grant = yield* authorize(token, PlaybackToken.PLAY, streamId);

        const view = yield* sessions.playlist(streamId, generation, grant);
        const query = `?${failures.tokens.param}=${encodeURIComponent(Redacted.value(token))}`;

        const body = renderPlaylist(view.plan, {
          init: `init.mp4${query}`,
          segment: (index) => `${index}.m4s${query}`,
        });

        return HttpServerResponse.text(body, {
          contentType: "application/vnd.apple.mpegurl",
          headers: { "cache-control": "no-store" },
        });
      }),
    ).pipe(Effect.withSpan("MediaRoutes.playlist"));

    const hlsFile = observed(failures, "hls", (authorize) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { streamId, generation, file } = yield* streamParams;

        const grant = yield* authorize(
          yield* PlaybackToken.tokenOf(request, failures.tokens.param),
          PlaybackToken.PLAY,
          streamId,
        );

        const segmentMatch = /^(\d+)\.m4s$/.exec(file);

        if (file !== "init.mp4" && segmentMatch === null)
          return yield* new SegmentNotFound({ index: -1 });
        const segmentIndex = segmentMatch === null ? -1 : Number(segmentMatch[1]);
        const started = yield* Clock.currentTimeMillis;

        const readMs = yield* Ref.make(0);

        const answer =
          segmentMatch === null
            ? yield* sessions.init(streamId, generation, grant).pipe(
                Effect.map((bytes) => ({
                  body: Stream.make(bytes),
                  contentLength: bytes.byteLength,
                })),
              )
            : yield* sessions.segment(streamId, generation, segmentIndex, grant).pipe(
                Effect.map((served) => ({
                  body: Stream.fromIterable(served.parts).pipe(
                    Stream.flatMap((part) => readWhole(part.file, part.sizeBytes, readMs)),
                  ),
                  contentLength: served.sizeBytes,
                })),
              );

        const answered = yield* Clock.currentTimeMillis;
        const { body, contentLength } = answer;

        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            const finished = yield* Clock.currentTimeMillis;
            const bodyReadMs = yield* Ref.get(readMs);
            const elapsedMs = finished - started;

            const timing = {
              route: "hls",
              streamId,
              generation,
              segment: segmentMatch === null ? "init" : segmentIndex,
              elapsedMs,
              encoderWaitMs: answered - started,
              diskReadMs: bodyReadMs,
              networkWriteMs: Math.max(0, finished - answered - bodyReadMs),
              bytes: contentLength,
              completed: Exit.isSuccess(exit),
              ...grantAnnotations(grant),
            };

            yield* (
              elapsedMs >= SLOW_MS
                ? Effect.logWarning(LogEvent.slowSegment)
                : Effect.logDebug(LogEvent.segmentServed)
            ).pipe(Effect.annotateLogs(timing));
          }),
        );

        return HttpEffect.scopeTransferToStream(
          HttpServerResponse.stream(body, {
            contentType: "video/mp4",
            contentLength,
            headers: { "cache-control": SEGMENT_CACHE },
          }),
        );
      }),
    ).pipe(Effect.withSpan("MediaRoutes.hls"));

    const subtitle = observed(failures, "subtitle", (authorize) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { fileId = "", track = "" } = yield* HttpRouter.params;

        const grant = yield* authorize(
          yield* PlaybackToken.tokenOf(request, failures.tokens.param),
          PlaybackToken.PLAY_OR_DOWNLOAD,
          PlaybackToken.READ,
        );

        if (!PlaybackToken.admitsFile(grant, fileId)) return yield* new MediaAccessDenied();
        const file = yield* resolve(grant.fileId, { sidecars: true });
        const vtt = yield* subtitles.toWebVtt(file, track.replace(/\.vtt$/, ""));

        return HttpServerResponse.text(vtt, {
          contentType: "text/vtt; charset=utf-8",
          headers: { "cache-control": SEGMENT_CACHE },
        });
      }),
    ).pipe(Effect.withSpan("MediaRoutes.subtitle"));

    yield* router.add("*", "/media/direct/:fileId", direct);
    yield* router.add("*", "/media/downloads/:fileId/:name", download);
    yield* router.add("GET", "/media/hls/:streamId/:generation/index.m3u8", playlist);
    yield* router.add("GET", "/media/hls/:streamId/:generation/:file", hlsFile);
    yield* router.add("GET", "/media/subtitles/:fileId/:track", subtitle);
  }),
);
