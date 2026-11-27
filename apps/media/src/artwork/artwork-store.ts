import { createHash } from "node:crypto";

import type { ArtworkWidth, CoverSize } from "@media/contracts/artwork";
import {
  Cache,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
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
   * What to serve for a music cover the server holds asked at `size`: its copy, with the shorter
   * side resized to `size`, since every cover is drawn as a square crop, and written as `format`,
   * or the stored cover. `fingerprint` names the file's content; the copy is kept under it with the
   * other resized artwork, within `CACHE_MAX_MB`.
   */
  readonly coverCopy: (
    file: string,
    fingerprint: string,
    size: CoverSize,
    format: CoverFormat,
  ) => Effect.Effect<CoverCopy>;
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
 * What the art route serves for a music cover at a size. `Stored` is decided once per cover and
 * size and remembered: the copy would not be smaller than the cover, or ffmpeg found an error in
 * the cover. `Busy` is for this request alone: `MAX_COVER_COPIES` copies are already under way.
 */
export type CoverCopy = Data.TaggedEnum<{
  Copy: { readonly image: ArtworkImage };
  Stored: {};
  Busy: {};
}>;

/** Constructors and matchers for `CoverCopy`. */
export const CoverCopy = Data.taggedEnum<CoverCopy>();

/**
 * How many distinct music cover copies may be under way at once, two encoding and the rest
 * waiting for an encoder. A first request past it gets the stored cover and makes no copy.
 */
const MAX_COVER_COPIES = 16;

/** The longer side's even rounding of the shorter side's `scaled` size, at most `longer`. */
const evenLonger = (scaled: string, longer: string, shorter: string) =>
  `min(${longer},2*floor((${scaled}*${longer}+${shorter})/(2*${shorter})))`;

/**
 * How a music cover's copy is written at `size`: its shorter side bounded by `size`, since a cover
 * is drawn as a square crop that then has the size each way, and the longer side rounded to an
 * even number of pixels, never past the cover's own size. It scales with Lanczos, the sharpest of
 * ffmpeg's filters, since a copy at a cell's exact size is drawn pixel for pixel, and the JPEG keeps
 * colour at every pixel (4:4:4): a small copy of a 4:2:0 cover would otherwise hold colour at half
 * its size, blurring saturated edges the original keeps when drawn as small.
 */
const coverPlan = (format: CoverFormat, size: string) => {
  const scale =
    `scale='if(gt(iw,ih),${evenLonger(`min(${size},ih)`, "iw", "ih")},min(${size},iw))'` +
    `:'if(gt(iw,ih),min(${size},ih),${evenLonger(`min(${size},iw)`, "ih", "iw")})':flags=lanczos`;

  return format === "jpeg"
    ? {
        extension: "jpg",
        contentType: "image/jpeg",
        filter: scale,
        quality: ["-pix_fmt", "yuvj444p", "-q:v", "3"],
      }
    : {
        extension: "png",
        contentType: "image/png",
        filter: `premultiply=inplace=1,${scale},unpremultiply=inplace=1`,
        quality: [],
      };
};

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

  const resize = Effect.fn("ArtworkStore.resize")(function* (
    file: string,
    fingerprint: string,
    width: ArtworkWidth,
  ) {
    const target = path.join(directory, `w${String(width)}`, `${hash(fingerprint)}.jpg`);

    if (yield* cached(target)) return target;

    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part.jpg`;

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
          `scale='min(${String(width)},iw)':-2`,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          temporary,
        ])
        .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause }))),
    );

    yield* fs
      .rename(temporary, target)
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));

    return target;
  });

  const images = yield* Cache.makeWith(
    ([key, width]: readonly [string, Option.Option<ArtworkWidth>]) =>
      Effect.gen(function* () {
        const source = yield* keys.open(key);

        if (Option.isNone(source)) return yield* new ArtworkNotFound();
        const { file, fingerprint } = yield* original(source.value);

        if (Option.isNone(width)) return { path: file, contentType: contentTypeOf(file) };

        return { path: yield* resize(file, fingerprint, width.value), contentType: "image/jpeg" };
      }),
    {
      capacity: 2048,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero),
    },
  );

  /** How many cover copies are under way, encoding or waiting for an encoder. */
  const underWay = yield* Ref.make(0);

  /**
   * Encodes `file`'s copy to `target`, which it keeps only when it is smaller than the cover.
   * Otherwise, and when ffmpeg finds an error in the cover, it deletes the output and writes the
   * `marker` that answers later requests with the stored cover.
   */
  const encodeCover = Effect.fnUntraced(function* (
    file: string,
    target: string,
    marker: string,
    plan: ReturnType<typeof coverPlan>,
  ): Effect.fn.Return<CoverCopy> {
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part.${plan.extension}`;

    const smaller = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* resizes.withPermits(1)(
        tools.ffmpeg([
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-y",
          // Stop at the first error in the cover, so a damaged cover is never copied.
          "-err_detect",
          "explode",
          "-i",
          file,
          "-vf",
          plan.filter,
          "-frames:v",
          "1",
          ...plan.quality,
          temporary,
        ]),
      );
      const [copy, cover] = yield* Effect.all([fs.stat(temporary), fs.stat(file)]);

      if (copy.size >= cover.size) return false;
      yield* fs.rename(temporary, target);

      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("ArtworkStore.cover_copy_failed", cause).pipe(Effect.as(false)),
      ),
    );

    if (smaller) return CoverCopy.Copy({ image: { path: target, contentType: plan.contentType } });
    yield* fs.remove(temporary, { force: true }).pipe(Effect.ignore);
    yield* fs.writeFile(marker, new Uint8Array(0)).pipe(Effect.ignore);

    return CoverCopy.Stored();
  });

  const cover = Effect.fn("ArtworkStore.cover")(function* (
    file: string,
    fingerprint: string,
    size: CoverSize,
    format: CoverFormat,
  ): Effect.fn.Return<CoverCopy> {
    const plan = coverPlan(format, String(size));
    const name = path.join(directory, `s${String(size)}`, hash(fingerprint));
    const target = `${name}.${plan.extension}`;

    if (yield* cached(target)) {
      return CoverCopy.Copy({ image: { path: target, contentType: plan.contentType } });
    }

    if (yield* cached(`${name}.stored`)) return CoverCopy.Stored();

    const admitted = yield* Ref.modify(underWay, (copies) =>
      copies < MAX_COVER_COPIES ? [true, copies + 1] : [false, copies],
    );

    if (!admitted) return CoverCopy.Busy();

    return yield* encodeCover(file, target, `${name}.stored`, plan).pipe(
      Effect.ensuring(Ref.update(underWay, (copies) => copies - 1)),
    );
  });

  // Concurrent requests for one copy share a single ffmpeg run and one place under the bound.
  // Nothing outlives that run, so each later request finds the copy or the marker on disk again,
  // or makes it again after the cache pruner removed it.
  const covers = yield* Cache.makeWith(
    ([file, fingerprint, size, format]: readonly [string, string, CoverSize, CoverFormat]) =>
      cover(file, fingerprint, size, format),
    { capacity: 2048, timeToLive: () => Duration.zero },
  );

  return Service.of({
    image: (key, width) => Cache.get(images, [key, width] as const),
    coverCopy: (file, fingerprint, size, format) =>
      Cache.get(covers, [file, fingerprint, size, format] as const),
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
