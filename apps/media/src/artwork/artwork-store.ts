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

class ArtworkNotFound extends Schema.TaggedError<ArtworkNotFound>()("ArtworkNotFound", {}) {
  override get message(): string {
    return "Artwork not found";
  }
}

class ArtworkUnavailable extends Schema.TaggedError<ArtworkUnavailable>()("ArtworkUnavailable", {
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

class ArtworkTooLarge extends Schema.TaggedError<ArtworkTooLarge>()("ArtworkTooLarge", {}) {
  override get message(): string {
    return "Artwork too large";
  }
}

class ArtworkDownloadTimedOut extends Schema.TaggedError<ArtworkDownloadTimedOut>()(
  "ArtworkDownloadTimedOut",
  {},
) {
  override get message(): string {
    return "Artwork download timed out";
  }
}

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

  return Service.of({
    image: (key, width) => Cache.get(images, [key, width] as const),
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
