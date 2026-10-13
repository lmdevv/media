/**
 * The media HTTP API under `/media`: health, signed audio streams, and signed artwork. Every
 * handler turns its failures into a response; access is decided only by Convex's signatures.
 */
import { resolve, sep } from "node:path";

import { TrackId } from "@music/commands/ids";
import { StreamProfile, StreamTimingHeader } from "@music/commands/models";
import { Cache, Clock, Duration, Effect, Exit, Option, Schema } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";

import packageJson from "../package.json" with { type: "json" };
import { artPath, imageContentType, isArtHash } from "./art-store.ts";
import { contentTypeFor, isBrowserPlayable } from "./audio-format.ts";
import { isFragmentedProfile } from "./ffmpeg.ts";
import { fileResponse, STREAM_CACHE_CONTROL } from "./file-response.ts";
import * as Files from "./files.ts";
import { MediaBackend, type TrackSource } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import { isSignedRequestValid } from "./signed-request.ts";
import { transcodedResponse } from "./transcoded-response.ts";
import { Transcoder } from "./transcoder.ts";

/** What request handlers run on. */
type Services = MediaBackend | MediaConfig | Transcoder;

const ART_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SOURCE_TTL = Duration.seconds(60);

const HEALTH_TIMEOUT = "3 seconds";

const decodeProfile = Schema.decodeUnknownOption(StreamProfile);

const decodeTrackId = Schema.decodeUnknownOption(TrackId);

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/**
 * Answers once the client behind `signal` has gone away, with a response nobody receives. Raced
 * against a handler, it interrupts the handler, which then releases what it holds.
 */
const clientGone = (signal: AbortSignal): Effect.Effect<Response> =>
  Effect.callback<Response>((resume) => {
    const gone = () => {
      resume(Effect.succeed(text(499, "Client closed request")));
    };

    if (signal.aborted) return gone();
    signal.addEventListener("abort", gone, { once: true });

    return Effect.sync(() => {
      signal.removeEventListener("abort", gone);
    });
  });

/** Joins a library-relative path onto its root, refusing paths that escape the root. */
const resolveInside = (root: string, relative: string): Option.Option<string> => {
  const base = resolve(root);
  const absolute = resolve(base, relative);

  return absolute.startsWith(base + sep) ? Option.some(absolute) : Option.none();
};

const serveOriginal = (request: Request, path: string, source: TrackSource) =>
  fileResponse(request, path, {
    contentType: contentTypeFor(source.path),
    cacheControl: STREAM_CACHE_CONTROL,
  });

/** Builds the Hono app; handlers run on the services captured here. */
export const makeHttpApp = Effect.gen(function* () {
  const context = yield* Effect.context<Services>();
  const run = Effect.runPromiseWith(context);
  const backend = yield* MediaBackend;
  const config = yield* MediaConfig;
  const transcoder = yield* Transcoder;

  // Found sources are reused for a minute; misses and failures are looked up again every time.
  const sources = yield* Cache.makeWith((trackId: TrackId) => backend.trackSource(trackId), {
    capacity: 10_000,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value) ? SOURCE_TTL : Duration.zero,
  });

  const streamTrack = Effect.fn("Http.streamTrack")(
    function* (request: Request, rawTrackId: string, url: URL) {
      const trackId = decodeTrackId(rawTrackId);
      const profile = decodeProfile(url.searchParams.get("p") ?? "original");

      if (Option.isNone(trackId) || Option.isNone(profile))
        return text(400, "Unknown track or profile");

      const valid = yield* isSignedRequestValid(
        config.signingKey,
        { kind: "stream", trackId: trackId.value, profile: profile.value },
        {
          exp: url.searchParams.get("exp") ?? undefined,
          sig: url.searchParams.get("sig") ?? undefined,
        },
      );

      if (!valid) return text(403, "Invalid or expired signature");
      const found = yield* Cache.get(sources, trackId.value);

      if (Option.isNone(found)) return text(404, "Track not found");
      const source = found.value;
      const lexical = resolveInside(source.libraryPath, source.path);

      if (Option.isNone(lexical)) return text(404, "Track not found");
      // The file may have become a symlink since the scan; serve only what still resolves inside
      // the library, and open the resolved path.
      const absolute = yield* Files.resolveWithin(source.libraryPath, lexical.value);

      if (Option.isNone(absolute)) return text(404, "Track not found");

      const original = serveOriginal(request, absolute.value, source);

      if (profile.value === "original") return yield* original;
      const transcodeProfile = profile.value;

      const response = yield* transcodedResponse(request, {
        trackId: trackId.value,
        profile: transcodeProfile,
        source: absolute.value,
        mtimeMs: source.mtimeMs,
        codec: source.codec,
      }).pipe(
        Effect.catchTag("TranscodeError", (error) =>
          // The gapless engine cannot append original bytes, so fragmented profiles never fall
          // back; the player switches to HTML audio on the error instead.
          !isFragmentedProfile(transcodeProfile) && isBrowserPlayable(source.codec, source.path)
            ? Effect.logWarning("Http.transcode_fallback", error).pipe(Effect.andThen(original))
            : Effect.logError("Http.transcode_failed", error).pipe(
                Effect.as(text(502, "Transcode failed")),
              ),
        ),
      );

      return response;
    },
    (effect, _request, rawTrackId) =>
      effect.pipe(
        Effect.catchTags({
          BackendError: (error) =>
            Effect.logError("Http.backend_unavailable", error).pipe(
              Effect.as(text(503, "Library unavailable")),
            ),
          FileError: (error) =>
            (error.missing
              ? Effect.logWarning("Http.file_missing", error).pipe(
                  Effect.andThen(Cache.invalidate(sources, TrackId.make(rawTrackId))),
                )
              : Effect.logError("Http.file_unreadable", error)
            ).pipe(
              Effect.as(
                text(
                  error.missing ? 404 : 500,
                  error.missing ? "File not found" : "File unreadable",
                ),
              ),
            ),
        }),
      ),
  );

  const serveArt = Effect.fn("Http.serveArt")(
    function* (request: Request, hash: string, url: URL) {
      if (!isArtHash(hash)) return text(404, "Artwork not found");

      const valid = yield* isSignedRequestValid(
        config.signingKey,
        { kind: "art", hash },
        {
          exp: url.searchParams.get("exp") ?? undefined,
          sig: url.searchParams.get("sig") ?? undefined,
        },
      );

      if (!valid) return text(403, "Invalid or expired signature");
      const path = artPath(config.dataDir, hash);
      const head = yield* Files.readHead(path, 16);

      return yield* fileResponse(request, path, {
        contentType: imageContentType(head),
        cacheControl: ART_CACHE_CONTROL,
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catchTag("FileError", (error) =>
          error.missing
            ? Effect.succeed(text(404, "Artwork not found"))
            : Effect.logError("Http.art_unreadable", error).pipe(
                Effect.as(text(500, "Artwork unreadable")),
              ),
        ),
      ),
  );

  const health = Effect.gen(function* () {
    const [convex, ffmpeg] = yield* Effect.all(
      [
        backend.ping.pipe(
          Effect.timeout(HEALTH_TIMEOUT),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
        transcoder.ffmpegAvailable,
      ],
      { concurrency: 2 },
    );

    const ok = convex && ffmpeg;

    return Response.json(
      { ok, convex, ffmpeg, version: packageJson.version },
      { status: ok ? 200 : 503 },
    );
  });

  // A handler runs only while its client is there: `@hono/node-server` neither reads nor cancels
  // the response of a client that left early, so anything it holds would never be released.
  const respond = (request: Request, handler: Effect.Effect<Response, never, Services>) =>
    run(Effect.raceFirst(handler, clientGone(request.signal)));

  const app = new Hono().basePath("/media");

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "HEAD", "OPTIONS"],
      allowHeaders: ["Range", "If-Range", "If-None-Match"],
      exposeHeaders: [
        "Content-Range",
        "Accept-Ranges",
        "Content-Length",
        "ETag",
        ...Object.values(StreamTimingHeader),
      ],
      maxAge: 86_400,
    }),
  );

  // Access log without query strings: signatures stay out of the logs.
  app.use("*", async (c, next) => {
    const started = await run(Clock.currentTimeMillis);
    await next();
    const finished = await run(Clock.currentTimeMillis);

    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: finished - started,
    };

    await run(
      (c.req.path.endsWith("/health")
        ? Effect.logDebug("Http.request")
        : Effect.logInfo("Http.request")
      ).pipe(Effect.annotateLogs(fields)),
    );
  });

  app.get("/health", () => run(health));
  app.get("/stream/:trackId", (c) =>
    respond(c.req.raw, streamTrack(c.req.raw, c.req.param("trackId"), new URL(c.req.url))),
  );
  app.get("/art/:hash", (c) =>
    respond(c.req.raw, serveArt(c.req.raw, c.req.param("hash"), new URL(c.req.url))),
  );
  app.notFound(() => text(404, "Not found"));
  app.onError(async (error) => {
    await run(Effect.logError("Http.unhandled", error));

    return text(500, "Internal error");
  });

  return app;
});
