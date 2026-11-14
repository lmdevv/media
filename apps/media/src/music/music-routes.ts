/**
 * Music's byte routes (`@media/contracts/music-playback`), as old music's media service served
 * them on Hono, on the server's Effect HTTP router (ADR 0010): a song's stream at a profile to its
 * personal ticket, and album art to its shareable ticket (ADR 0011). Answers are plain text with
 * the statuses old music's players read. No answer, log, or span carries a ticket.
 */
import { TrackId } from "@media/contracts/ids";
import {
  MUSIC_ROUTES,
  MUSIC_STREAM_PARAMS,
  MusicStreamProfile,
} from "@media/contracts/music-playback";
import { Effect, FileSystem, Layer, Option, Path, Predicate, Result, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ArtworkGate from "../artwork/artwork-gate.ts";
import * as MediaConfig from "../media-config.ts";
import { realPathInsideApprovedRoots } from "../playback/file-resolver.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import { artPath, imageContentType, isArtHash } from "./art-store.ts";
import { contentTypeFor, isBrowserPlayable } from "./audio-format.ts";
import { isFragmentedProfile } from "./ffmpeg-args.ts";
import * as Files from "./music-files.ts";
import {
  fileResponse,
  finishedResponse,
  offsetResponse,
  transcodedResponse,
} from "./music-responses.ts";
import * as TrackSources from "./track-sources.ts";
import * as MusicTranscoder from "./transcoder.ts";

const ART_CACHE_CONTROL = "public, max-age=31536000, immutable";

const decodeProfile = Schema.decodeUnknownOption(MusicStreamProfile);

const START_MS = /^\d{1,9}$/u;

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const parseStart = (raw: string | null): Option.Option<number> => {
  if (raw === null) return Option.some(0);

  return START_MS.test(raw) ? Option.some(Number(raw)) : Option.none();
};

const parseFinished = (raw: string | null): Option.Option<boolean> => {
  if (raw === null) return Option.some(false);

  return raw === "1" ? Option.some(true) : Option.none();
};

const searchOf = (request: HttpServerRequest.HttpServerRequest): URLSearchParams =>
  new URL(request.url, "http://media.invalid").searchParams;

/** Adds music's stream and art routes. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | MediaConfig.Service
  | PlaybackToken.Service
  | ArtworkGate.Service
  | TrackSources.Service
  | MusicTranscoder.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const config = yield* MediaConfig.Service;
    const tokens = yield* PlaybackToken.Service;
    const gate = yield* ArtworkGate.Service;
    const sources = yield* TrackSources.Service;

    const transcoder = yield* MusicTranscoder.Service;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    /**
     * The services a request runs on, provided one by one. Never the layer's whole context: it
     * holds the layer's own scope, which would then stand in for the request's, so a live
     * transcode would hold its run in the layer's scope and its response would close that scope
     * when its body ends (`HttpEffect.scopeTransferToStream`).
     */
    const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(MediaConfig.Service, config),
        Effect.provideService(MusicTranscoder.Service, transcoder),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, paths),
      );

    /**
     * The real path of a track's file: inside the library folder that holds it and inside an
     * approved `LIBRARY_ROOTS` entry, after following links, so a link swapped into a library
     * cannot serve a file from elsewhere. None for a file outside either.
     */
    const realFileOf = Effect.fnUntraced(function* (path: string, roots: ReadonlyArray<string>) {
      const root = roots.find((folder) => Files.isInsideFolder(path, folder));

      if (root === undefined) return Option.none<string>();

      const inside = yield* Files.resolveWithin(root, path);

      if (Option.isNone(inside)) return inside;

      return yield* realPathInsideApprovedRoots(inside.value);
    });

    const stream = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(405, "Use GET or HEAD", { allow: "GET, HEAD" });
      }

      const { trackId = "" } = yield* HttpRouter.params;
      const search = searchOf(request);
      const profile = decodeProfile(search.get(MUSIC_STREAM_PARAMS.profile) ?? "original");
      const startMs = parseStart(search.get(MUSIC_STREAM_PARAMS.start));
      const finished = parseFinished(search.get(MUSIC_STREAM_PARAMS.finished));

      if (Option.isNone(profile)) return text(400, "Unknown profile");

      if (Option.isNone(finished)) return text(400, "Invalid finished");

      if (
        Option.isNone(startMs) ||
        (startMs.value > 0 && (profile.value === "original" || finished.value))
      ) {
        return text(400, "Invalid start");
      }

      // Every request needs an unexpired ticket, as old music's signed URLs did, so a listener who
      // lost access gets nothing once their play's ticket runs out (ADR 0010). A response under way
      // runs to its end unless its session ends.
      const grant = yield* Effect.result(
        Effect.gen(function* () {
          const token = yield* PlaybackToken.tokenOf(request, tokens.param);

          return yield* tokens.authorize(token, PlaybackToken.PLAY_OR_DOWNLOAD);
        }),
      );

      if (Result.isFailure(grant)) {
        const refusal = Predicate.isTagged(grant.failure, "TokenRefused")
          ? grant.failure.error
          : grant.failure;

        yield* Effect.logDebug("MusicRoutes.ticket_refused").pipe(
          Effect.annotateLogs({ trackId, reason: refusal.message }),
        );

        return Predicate.isTagged(refusal, "PlaybackSessionEnded")
          ? text(410, "This sign-in ended")
          : text(401, "Invalid or expired ticket");
      }

      const { sessionEnded } = grant.success;

      if (grant.success.resource !== "track" || grant.success.fileId !== trackId) {
        return text(403, "This ticket is for another song");
      }

      const found = yield* sources.resolve(trackId);

      if (Option.isNone(found)) return text(404, "Track not found");

      const source = found.value;
      const real = yield* realFileOf(source.path, source.roots);

      if (Option.isNone(real)) {
        yield* Effect.logWarning("MusicRoutes.outside_library").pipe(
          Effect.annotateLogs({ trackId }),
        );

        return text(404, "Track not found");
      }

      const original = fileResponse(request, real.value, {
        contentType: contentTypeFor(source.path),
        sessionEnded,
      });

      if (profile.value === "original") return yield* original;

      const transcodeProfile = profile.value;

      const input = {
        trackId: TrackId.make(trackId),
        profile: transcodeProfile,
        source: real.value,
        mtimeMs: source.mtimeMs,
        codec: source.codec,
      };

      const failed = (error: MusicTranscoder.TranscodeError) =>
        Effect.logError("MusicRoutes.transcode_failed", error).pipe(
          Effect.annotateLogs({ trackId, profile: transcodeProfile }),
          Effect.as(text(502, "Transcode failed")),
        );

      if (finished.value) {
        return yield* finishedResponse(request, input, sessionEnded).pipe(
          Effect.catchTag("TranscodeError", failed),
        );
      }

      if (startMs.value > 0) {
        // An offset is a fresh encode that only a reading GET may own: a HEAD response's body is
        // never read, which would leave its ffmpeg run blocked and its permit taken.
        if (request.method !== "GET") return text(405, "Offsets need GET", { allow: "GET" });

        return yield* offsetResponse(input, startMs.value, sessionEnded).pipe(
          Effect.catchTags({
            TranscodeError: failed,
            OffsetRunsBusy: (error) =>
              Effect.logWarning("MusicRoutes.offset_runs_busy", error).pipe(
                Effect.as(
                  text(503, "Too many seeks are transcoding; retry shortly", {
                    "retry-after": "2",
                  }),
                ),
              ),
          }),
        );
      }

      return yield* transcodedResponse(request, input, sessionEnded).pipe(
        Effect.catchTag("TranscodeError", (error) =>
          !isFragmentedProfile(transcodeProfile) && isBrowserPlayable(source.codec, source.path)
            ? Effect.logWarning("MusicRoutes.transcode_fallback", error).pipe(
                Effect.andThen(original),
              )
            : failed(error),
        ),
      );
    }).pipe(
      Effect.catchTags({
        TrackSourcesUnavailable: (error) =>
          Effect.logError("MusicRoutes.catalog_unavailable", error).pipe(
            Effect.as(text(503, "Library unavailable")),
          ),
        FileError: (error) =>
          error.missing
            ? Effect.logWarning("MusicRoutes.file_missing", error).pipe(
                Effect.andThen(HttpRouter.params),
                Effect.flatMap(({ trackId = "" }) => sources.forget(trackId)),
                Effect.as(text(404, "File not found")),
              )
            : Effect.logError("MusicRoutes.file_unreadable", error).pipe(
                Effect.as(text(500, "File unreadable")),
              ),
      }),
      services,
      Effect.withSpan("MusicRoutes.stream"),
    );

    const art = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(405, "Use GET or HEAD", { allow: "GET, HEAD" });
      }

      // A wildcard, not `:hash`, as the artwork route does: the router refuses long parameters.
      const { "*": hash = "" } = yield* HttpRouter.params;

      if (!isArtHash(hash)) return text(404, "Artwork not found");

      const ticket = searchOf(request).get(gate.param);

      if (ticket === null || !(yield* gate.admits(ticket, hash))) {
        return text(401, "Invalid or expired ticket");
      }

      const path = artPath(config.dataDir, hash);
      const head = yield* Files.readHead(path, 16);

      return yield* fileResponse(request, path, {
        contentType: imageContentType(head),
        sessionEnded: undefined,
      }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", ART_CACHE_CONTROL)));
    }).pipe(
      Effect.catchTag("FileError", (error) =>
        error.missing
          ? Effect.succeed(text(404, "Artwork not found"))
          : Effect.logError("MusicRoutes.art_unreadable", error).pipe(
              Effect.as(text(500, "Artwork unreadable")),
            ),
      ),
      services,
      Effect.withSpan("MusicRoutes.art"),
    );

    yield* router.add("*", MUSIC_ROUTES.stream, stream);
    yield* router.add("*", MUSIC_ROUTES.art, art);
  }),
);
