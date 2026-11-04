import { createHash } from "node:crypto";

import type { SubtitleTrack } from "@media/contracts/media-playback";
import { Context, Duration, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import type { CheckedMediaFile, ResolvedMediaFile } from "../playback/file-resolver.ts";

/** The stable ID of a sidecar subtitle file, from its file name. */
export const sidecarTrackId = (path: string): string =>
  `x${createHash("sha256")
    .update(path.split(/[\\/]/u).at(-1) ?? path)
    .digest("hex")
    .slice(0, 12)}`;

/** Every subtitle track of `file`, embedded first. */
export const subtitleTracks = (file: ResolvedMediaFile): ReadonlyArray<SubtitleTrack> => [
  ...file.probe.subtitles.map((subtitle): SubtitleTrack => ({
    id: `e${subtitle.index}`,
    source: "embedded",
    codec: subtitle.codec,
    kind: subtitle.kind,
    language: subtitle.language,
    title: subtitle.title,
    forced: subtitle.forced,
    default: subtitle.default,
    hearingImpaired: subtitle.hearingImpaired,
  })),
  ...file.subtitles.map((subtitle): SubtitleTrack => ({
    id: sidecarTrackId(subtitle.path),
    source: "sidecar",
    codec: subtitle.format,
    kind: "text",
    language: subtitle.language,
    title: subtitle.title,
    forced: subtitle.forced,
    default: subtitle.default,
    hearingImpaired: subtitle.hearingImpaired,
  })),
];

/** The file has no subtitle track with this ID. */
export class SubtitleTrackNotFound extends Schema.TaggedError<SubtitleTrackNotFound>()(
  "SubtitleTrackNotFound",
  { trackId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Subtitle track not found: ${this.trackId}`;
  }
}

/** The track is a bitmap format, which cannot become WebVTT. */
export class SubtitleUnsupported extends Schema.TaggedError<SubtitleUnsupported>()(
  "SubtitleUnsupported",
  { trackId: Schema.String, codec: Schema.String },
  { httpApiStatus: 415 },
) {
  override get message(): string {
    return `Subtitle unsupported: ${this.codec} is a bitmap format`;
  }
}

/** ffmpeg could not convert the track. */
export class SubtitleConversionFailed extends Schema.TaggedError<SubtitleConversionFailed>()(
  "SubtitleConversionFailed",
  { trackId: Schema.String, detail: Schema.String },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Subtitle conversion failed for ${this.trackId}: ${this.detail}`;
  }
}

/** Converts subtitle tracks to WebVTT. */
export interface Interface {
  readonly toWebVtt: (
    file: CheckedMediaFile,
    trackId: string,
  ) => Effect.Effect<
    string,
    SubtitleTrackNotFound | SubtitleUnsupported | SubtitleConversionFailed
  >;
}

/** The subtitle converter. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/SubtitleConverter",
) {}

const CACHE_NAMESPACE = "subtitles";

const CACHE_MAX_AGE = Duration.days(3650);

const MAX_CONVERSIONS = 2;

const webVttArgs = (input: string, map: ReadonlyArray<string>): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-i",
  input,
  ...map,
  "-c:s",
  "webvtt",
  "-f",
  "webvtt",
  "pipe:1",
];

const make = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* MediaConfig.Service;
  const conversions = yield* Semaphore.make(MAX_CONVERSIONS);

  const toWebVtt = Effect.fn("SubtitleConverter.toWebVtt")(function* (
    file: CheckedMediaFile,
    trackId: string,
  ) {
    const track = subtitleTracks(file).find((candidate) => candidate.id === trackId);

    if (track === undefined) return yield* new SubtitleTrackNotFound({ trackId });

    if (track.kind === "bitmap")
      return yield* new SubtitleUnsupported({ trackId, codec: track.codec });

    const sidecar =
      track.source === "sidecar"
        ? file.subtitles.find((candidate) => sidecarTrackId(candidate.path) === trackId)
        : undefined;

    const failed = (detail: string) => new SubtitleConversionFailed({ trackId, detail });

    const key =
      sidecar === undefined
        ? `${file.fileId}:${file.sizeBytes}:${file.modifiedAtMs}:${trackId}`
        : yield* fs.stat(sidecar.readPath).pipe(
            Effect.map(
              (info) => `sidecar:${sidecar.path}:${String(info.size)}:${modifiedAtMs(info)}`,
            ),
            Effect.mapError(() => failed("unreadable")),
          );

    const cached = yield* cache.read(CACHE_NAMESPACE, key, CACHE_MAX_AGE);

    if (Option.isSome(cached) && cached.value.startsWith("WEBVTT")) return cached.value;

    if (sidecar?.format === "vtt") {
      const text = yield* fs
        .readFileString(sidecar.readPath)
        .pipe(Effect.mapError(() => failed("unreadable")));

      if (text.replace(/^﻿/, "").startsWith("WEBVTT")) return text.replace(/^﻿/, "");
    }

    const args =
      sidecar === undefined
        ? webVttArgs(file.path, ["-map", `0:${trackId.slice(1)}`])
        : webVttArgs(sidecar.readPath, ["-map", "0:s:0"]);

    const vtt = yield* conversions.withPermits(1)(
      tools
        .ffmpeg(args, { timeout: config.fileScanTimeout })
        .pipe(
          Effect.mapError((error) =>
            failed(
              error.exitCode === null
                ? error.stderr
                : `ffmpeg exited with ${String(error.exitCode)}`,
            ),
          ),
        ),
    );

    yield* cache.write(CACHE_NAMESPACE, key, vtt);

    return vtt;
  });

  return Service.of({ toWebVtt });
});

/** The converter over ffmpeg and the disk cache. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaTools.Service | DiskCache.Service | FileSystem.FileSystem | MediaConfig.Service
> = Layer.effect(Service, make);
