import { createHash } from "node:crypto";

import type { ArtworkWidth } from "@media/contracts/artwork";
import {
  Cache,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { markUsed } from "../cache-pruner.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import { realPathInsideApprovedRoots } from "../playback/file-resolver.ts";
import * as ArtworkKeys from "./artwork-keys.ts";
import { ArtworkSource } from "./artwork-keys.ts";

interface ArtworkImage {
  readonly path: string;
  readonly contentType: string;
}

class ArtworkNotFound extends Schema.TaggedError<
  ArtworkNotFound,
  { readonly brand: unique symbol }
>()("ArtworkNotFound", {}) {
  override get message(): string {
    return "Artwork not found";
  }
}

class ArtworkUnavailable extends Schema.TaggedError<
  ArtworkUnavailable,
  { readonly brand: unique symbol }
>()("ArtworkUnavailable", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Artwork unavailable: the image could not be fetched or resized";
  }
}

/** Serves artwork images. */
export interface Interface {
  /** The image behind `key`, resized to `width` when given. */
  readonly image: (
    key: string,
    width: Option.Option<ArtworkWidth>,
  ) => Effect.Effect<ArtworkImage, ArtworkNotFound | ArtworkUnavailable>;
  /**
   * A music cover the server holds, resized so its shorter side is `size`, since every cover is
   * drawn as a square crop, and written as `format`. `fingerprint` names the file's content, and
   * the copy is kept under it with the other resized artwork, within `CACHE_MAX_MB`.
   */
  readonly resizeCover: (
    file: string,
    fingerprint: string,
    size: ArtworkWidth,
    format: CoverFormat,
  ) => Effect.Effect<ArtworkImage, ArtworkUnavailable>;
}

/** The artwork store. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ArtworkStore") {}

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["image.tmdb.org"]);

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["tbn", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const DOWNLOAD_TIMEOUT = Duration.seconds(30);

const MAX_RESIZES = 2;

class ArtworkTooLarge extends Schema.TaggedError<
  ArtworkTooLarge,
  { readonly brand: unique symbol }
>()("ArtworkTooLarge", {}) {
  override get message(): string {
    return "Artwork too large";
  }
}

class ArtworkDownloadTimedOut extends Schema.TaggedError<
  ArtworkDownloadTimedOut,
  { readonly brand: unique symbol }
>()("ArtworkDownloadTimedOut", {}) {
  override get message(): string {
    return "Artwork download timed out";
  }
}

/**
 * The file format of a resized music cover. `jpeg` is for a cover without transparency. `png`
 * keeps a cover's alpha channel, and is scaled with premultiplied alpha, as browsers and iOS scale
 * it, so the colour under fully transparent pixels never bleeds into the edges.
 */
export type CoverFormat = "jpeg" | "png";

/**
 * How a resize bounds an image by the requested size, and the file it writes. `width` bounds the
 * width, for movie artwork, which is drawn at its own shape; it rounds the height to an even
 * number of pixels, which can enlarge an image with an odd height by one row. `shorter` bounds the
 * shorter side, for a music cover, which is drawn as a square crop that then has the size each
 * way. It rounds the longer side to an even number of pixels too, so a square cover's copy matches
 * the width bound's, but never past the cover's own size.
 */
type Resize =
  | { readonly bound: "width" }
  | { readonly bound: "shorter"; readonly format: CoverFormat };

/** The longer side's even rounding of the shorter side's `scaled` size, at most `longer`. */
const evenLonger = (scaled: string, longer: string, shorter: string) =>
  `min(${longer},2*floor((${scaled}*${longer}+${shorter})/(2*${shorter})))`;

const shorterScale = (size: string) =>
  `scale='if(gt(iw,ih),${evenLonger(`min(${size},ih)`, "iw", "ih")},min(${size},iw))'` +
  `:'if(gt(iw,ih),min(${size},ih),${evenLonger(`min(${size},iw)`, "ih", "iw")})'`;

/** The cache folder, file extension, content type, filter, and encoder options of `resize` at `size`. */
const plan = (resize: Resize, size: string) => {
  if (resize.bound === "width") {
    return {
      folder: `w${size}`,
      extension: "jpg",
      contentType: "image/jpeg",
      filter: `scale='min(${size},iw)':-2`,
      quality: ["-q:v", "3"],
    };
  }

  return resize.format === "jpeg"
    ? {
        folder: `s${size}`,
        extension: "jpg",
        contentType: "image/jpeg",
        filter: shorterScale(size),
        quality: ["-q:v", "3"],
      }
    : {
        folder: `s${size}`,
        extension: "png",
        contentType: "image/png",
        filter: `premultiply=inplace=1,${shorterScale(size)},unpremultiply=inplace=1`,
        quality: [],
      };
};

const timeToLive = (exit: Exit.Exit<unknown, unknown>): Duration.Duration =>
  Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero;

const contentTypeOf = (path: string): string =>
  CONTENT_TYPES.get(path.split(".").at(-1)?.toLowerCase() ?? "") ?? "application/octet-stream";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const keys = yield* ArtworkKeys.Service;
  const tools = yield* MediaTools.Service;
  const http = yield* HttpClient.HttpClient;
  const directory = path.join(config.dataDir, "artwork");
  const resizes = yield* Semaphore.make(MAX_RESIZES);

  const provide = <A, E>(
    effect: Effect.Effect<A, E, MediaConfig.Service | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const cached = (target: string) =>
    markUsed(target).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const writeAtomically = Effect.fnUntraced(function* (target: string, bytes: Uint8Array) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part`;
    yield* fs.writeFile(temporary, bytes);
    yield* fs.rename(temporary, target);
  });

  const download = Effect.fn("ArtworkStore.download")(function* (url: string) {
    const host = Option.liftThrowable(() => new URL(url).host)();

    if (Option.isNone(host) || !ALLOWED_HOSTS.has(host.value)) {
      return yield* new ArtworkNotFound();
    }

    const extension = url.split(".").at(-1)?.toLowerCase() ?? "jpg";
    const target = path.join(directory, "originals", `${hash(url)}.${extension}`);

    if (yield* cached(target)) return target;

    const bytes = yield* http.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        Number(response.headers["content-length"] ?? "0") > MAX_DOWNLOAD_BYTES
          ? Effect.fail(new ArtworkTooLarge())
          : response.stream.pipe(
              Stream.runFoldEffect(
                () => ({ chunks: new Array<Uint8Array>(), size: 0 }),
                (read, chunk) =>
                  read.size + chunk.length > MAX_DOWNLOAD_BYTES
                    ? Effect.fail(new ArtworkTooLarge())
                    : Effect.sync(() => {
                        read.chunks.push(chunk);

                        return { chunks: read.chunks, size: read.size + chunk.length };
                      }),
              ),
              Effect.map((read) => Buffer.concat(read.chunks)),
            ),
      ),
      Effect.timeoutOrElse({
        duration: DOWNLOAD_TIMEOUT,
        orElse: () => Effect.fail(new ArtworkDownloadTimedOut()),
      }),
      Effect.mapError((cause) => new ArtworkUnavailable({ cause })),
    );

    yield* writeAtomically(target, bytes).pipe(
      Effect.mapError((cause) => new ArtworkUnavailable({ cause })),
    );

    return target;
  });

  const original = Effect.fn("ArtworkStore.original")(function* (source: ArtworkSource) {
    return yield* ArtworkSource.$match(source, {
      Local: ({ path: candidate }) =>
        Effect.gen(function* () {
          // The canonical path from here on, so a link swapped after the check cannot redirect.
          const inside = yield* provide(realPathInsideApprovedRoots(candidate));

          if (Option.isNone(inside)) return yield* new ArtworkNotFound();

          const file = inside.value;

          const info = yield* fs.stat(file).pipe(Effect.mapError(() => new ArtworkNotFound()));

          return {
            file,
            fingerprint: `${candidate}\u0000${String(info.size)}\u0000${modifiedAtMs(info)}`,
          };
        }),
      Remote: ({ url }) => download(url).pipe(Effect.map((file) => ({ file, fingerprint: url }))),
    });
  });

  const resizeFile = Effect.fn("ArtworkStore.resize")(function* (
    file: string,
    fingerprint: string,
    size: ArtworkWidth,
    resize: Resize,
  ) {
    // Each bound keeps its copies in its own folder, so the same file never answers both.
    const { folder, extension, contentType, filter, quality } = plan(resize, String(size));
    const target = path.join(directory, folder, `${hash(fingerprint)}.${extension}`);
    const image: ArtworkImage = { path: target, contentType };

    if (yield* cached(target)) return image;

    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part.${extension}`;

    yield* resizes.withPermits(1)(
      tools
        .ffmpeg([
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-i",
          file,
          "-vf",
          filter,
          "-frames:v",
          "1",
          ...quality,
          temporary,
        ])
        .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause }))),
    );

    yield* fs
      .rename(temporary, target)
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));

    return image;
  });

  // Concurrent requests for one copy share a single ffmpeg run. Nothing outlives that run, so each
  // later request finds the copy on disk again, or makes it again after the cache pruner removed it.
  const copies = yield* Cache.makeWith(
    ([file, fingerprint, size, resize]: readonly [string, string, ArtworkWidth, Resize]) =>
      resizeFile(file, fingerprint, size, resize),
    { capacity: 2048, timeToLive: () => Duration.zero },
  );

  const resizeImage = (file: string, fingerprint: string, size: ArtworkWidth, resize: Resize) =>
    Cache.get(copies, [file, fingerprint, size, resize] as const);

  const images = yield* Cache.makeWith(
    ([key, width]: readonly [string, Option.Option<ArtworkWidth>]) =>
      Effect.gen(function* () {
        const source = yield* keys.open(key);

        if (Option.isNone(source)) return yield* new ArtworkNotFound();
        const { file, fingerprint } = yield* original(source.value);

        if (Option.isNone(width)) return { path: file, contentType: contentTypeOf(file) };

        return yield* resizeImage(file, fingerprint, width.value, { bound: "width" });
      }),
    { capacity: 2048, timeToLive },
  );

  return Service.of({
    image: (key, width) => Cache.get(images, [key, width] as const),
    resizeCover: (file, fingerprint, size, format) =>
      resizeImage(file, fingerprint, size, { bound: "shorter", format }),
  });
});

/** The store under `DATA_DIR/artwork`. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | ArtworkKeys.Service
  | MediaTools.Service
  | HttpClient.HttpClient
> = Layer.effect(Service, make);
