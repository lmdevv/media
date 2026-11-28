/**
 * Music's byte routes (`@media/contracts/music-playback`) on the server's Effect HTTP router
 * (ADR 0010): a song's stream at a profile to its personal ticket, and album art to its shareable
 * ticket (ADR 0011), as stored or with its shorter side resized to one of `COVER_SIZES` when it is
 * of a kind a copy is proven to show the same (`coverKind`). Answers are plain text with the
 * statuses music's players read. No answer, log, or span carries a ticket.
 */
import { requestedCoverSize } from "@media/contracts/artwork";
import { isReceiverCredential } from "@media/contracts/cast";
import { TrackId } from "@media/contracts/ids";
import {
  MUSIC_ROUTES,
  MUSIC_STREAM_PARAMS,
  MusicStreamProfile,
} from "@media/contracts/music-playback";
import {
  Cache,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ArtworkGate from "../artwork/artwork-gate.ts";
import * as ArtworkStore from "../artwork/artwork-store.ts";
import * as MediaConfig from "../media-config.ts";
import { isNotFound } from "../platform/file-info.ts";
import { realPathInsideApprovedRoots } from "../playback/file-resolver.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import { artPath, imageContentType, isArtHash } from "./art-store.ts";
import { contentTypeFor, isBrowserPlayable } from "./audio-format.ts";
import { type Classified, ClassifyWithin, COPIED_KINDS, coverKind } from "./cover-copy.ts";
import { isFragmentedProfile } from "./ffmpeg-args.ts";
import * as Files from "./music-files.ts";
import {
  fileResponse,
  finishedResponse,
  offsetResponse,
  openFileResponse,
  transcodedResponse,
} from "./music-responses.ts";
import * as TrackSources from "./track-sources.ts";
import * as MusicTranscoder from "./transcoder.ts";

const ART_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** What a cover's copy calls for, told by its kind. */
const PLANS: Record<Classified, ArtworkStore.CopyPlan> = {
  ...COPIED_KINDS,
  unproven: "none",
  undecided: "later",
};

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
  | ArtworkStore.Service
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
    const store = yield* ArtworkStore.Service;

    const sources = yield* TrackSources.Service;

    const transcoder = yield* MusicTranscoder.Service;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const classifyWithin = yield* ClassifyWithin;

    // A cover's kind, by its content hash, which names the same bytes for good, told in one
    // forward pass over one open handle (`coverKind`). An `undecided` kind is told again later.
    const kinds = yield* Cache.makeWith(
      (hash: string) => {
        const path = artPath(config.dataDir, hash);

        const failed = (operation: string) => (cause: PlatformError.PlatformError) =>
          new Files.FileError({ operation, path, missing: isNotFound(cause), cause });

        return Effect.gen(function* () {
          const file = yield* fs.open(path).pipe(Effect.mapError(failed("open")));
          const info = yield* file.stat.pipe(Effect.mapError(failed("stat")));

          return yield* coverKind(
            Number(info.size),
            (offset, length) =>
              file
                .readAlloc(length, { position: BigInt(offset) })
                .pipe(
                  Effect.map(Option.getOrElse(() => new Uint8Array(0))),
                  Effect.mapError(failed("read")),
                ),
            classifyWithin,
          );
        }).pipe(Effect.scoped);
      },
      {
        capacity: 4096,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value !== "undecided" ? Duration.infinity : Duration.zero,
      },
    );

    /** Tells a cover's kind, which a request runs only once the store admitted its copy. */
    const plan = (hash: string) =>
      Cache.get(kinds, hash).pipe(
        Effect.map((kind) => PLANS[kind]),
        Effect.catchTag("FileError", (error) =>
          Effect.logWarning("MusicRoutes.art_kind_unread", error).pipe(Effect.as("later" as const)),
        ),
      );

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

      // Every request needs an unexpired ticket, so a listener who lost access gets nothing once
      // their play's ticket runs out (ADR 0010). A response under way runs to its end unless its
      // session ends. A Cast receiver's credential reads the song its sender's start was for,
      // while that start's admission stands and its session is live.
      const grant = yield* Effect.result(
        Effect.gen(function* () {
          const token = yield* PlaybackToken.tokenOf(request, tokens.param);

          const within = isReceiverCredential(Redacted.value(token))
            ? PlaybackToken.READ
            : undefined;

          return yield* tokens.authorize(token, PlaybackToken.PLAY_OR_DOWNLOAD, within);
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

      // A browser plays the original of a song whose AAC transcode failed, when it can play it.
      const failedOrOriginal = (error: MusicTranscoder.TranscodeError) =>
        !isFragmentedProfile(transcodeProfile) && isBrowserPlayable(source.codec, source.path)
          ? Effect.logWarning("MusicRoutes.transcode_fallback", error).pipe(
              Effect.andThen(original),
            )
          : failed(error);

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

      // A HEAD answers as `&finished=1` does, from the cache or with `503` and `Retry-After`, and
      // never waits for the encoder: a player asks for a song's exact timing while ffmpeg may be
      // minutes from the end, and goes away when it moves on.
      if (finished.value || request.method === "HEAD") {
        return yield* finishedResponse(request, input, sessionEnded).pipe(
          Effect.catchTag("TranscodeError", finished.value ? failed : failedOrOriginal),
        );
      }

      return yield* transcodedResponse(request, input, sessionEnded).pipe(
        Effect.catchTag("TranscodeError", failedOrOriginal),
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

      const search = searchOf(request);
      const width = requestedCoverSize(search);

      if (Result.isFailure(width)) return text(400, "Invalid width");

      const ticket = search.get(gate.param);

      if (ticket === null || !(yield* gate.admits(ticket, hash))) {
        return text(401, "Invalid or expired ticket");
      }

      const path = artPath(config.dataDir, hash);
      const size = width.success;
      const contentType = imageContentType(yield* Files.readHead(path, 16));
      const known = Option.isNone(size) ? Option.none() : yield* Cache.getSuccess(kinds, hash);

      // The art store names a cover by its content hash, so the hash alone names each copy. A
      // cover whose kind is not known yet has it told under the store's bound on copies.
      const answer =
        Option.isNone(size) || (Option.isSome(known) && known.value === "unproven")
          ? undefined
          : yield* store.coverCopy(
              path,
              `music-art:${hash}`,
              size.value,
              Option.isSome(known) ? Effect.succeed(PLANS[known.value]) : plan(hash),
            );

      // Open before answering: the copy's bytes then survive a prune before the body ends, and a
      // copy pruned before this serves the stored cover.
      const copy =
        answer !== undefined && ArtworkStore.CoverCopy.$is("Copy")(answer)
          ? answer.image
          : undefined;

      const copied =
        copy === undefined
          ? Option.none()
          : yield* fs.open(copy.path).pipe(
              Effect.flatMap((file) =>
                openFileResponse(request, file, {
                  contentType: copy.contentType,
                  sessionEnded: undefined,
                }),
              ),
              Effect.option,
            );

      const response = Option.isSome(copied)
        ? copied.value
        : yield* fileResponse(request, path, { contentType, sessionEnded: undefined });

      // The stored cover served only for want of a place under the bound, a kind told in time, or
      // a finished run is asked for again.
      return HttpServerResponse.setHeader(
        response,
        "cache-control",
        answer !== undefined && ArtworkStore.CoverCopy.$is("Busy")(answer)
          ? "no-store"
          : ART_CACHE_CONTROL,
      );
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
