import { KeyframeIndexFailed } from "@media/contracts/media-playback";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "./file-resolver.ts";
import { readMatroskaKeyframes } from "./matroska-cues.ts";
import { readMp4Keyframes } from "./mp4-keyframes.ts";

/** Keyframe times of media files. */
export interface Interface {
  /** Video keyframe times in seconds on the file's own timeline, ascending. */
  readonly keyframes: (
    file: ResolvedMediaFile,
  ) => Effect.Effect<ReadonlyArray<number>, KeyframeIndexFailed>;
  /**
   * The keyframes when they are known within `wait`, else none; a scan that takes longer goes on
   * in the background and caches its result for the next caller.
   */
  readonly keyframesWithin: (
    file: ResolvedMediaFile,
    wait: Duration.Duration,
  ) => Effect.Effect<Option.Option<ReadonlyArray<number>>, KeyframeIndexFailed>;
}

/** The keyframe index. */
export class Service extends Context.Service<Service, Interface>()("@media/server/KeyframeIndex") {}

const CACHE_NAMESPACE = "keyframes";

const CACHE_MAX_AGE = Duration.days(3650);

const Keyframes = Schema.fromJsonString(Schema.Array(Schema.Finite));

type Pending = Deferred.Deferred<ReadonlyArray<number>, KeyframeIndexFailed>;

type Running = ReadonlyMap<string, Pending>;

const decodeKeyframes = Schema.decodeEffect(Keyframes);

const encodeKeyframes = Schema.encodeEffect(Keyframes);

const parsePacketList = (csv: string): ReadonlyArray<number> =>
  csv
    .split("\n")
    .map((line) => line.trim().split(","))
    .filter(
      ([time, flags]) => time !== undefined && time !== "N/A" && (flags ?? "").startsWith("K"),
    )
    .map(([time]) => Number(time))
    .filter(Number.isFinite)
    .toSorted((left, right) => left - right);

const indexKind = (file: ResolvedMediaFile): Option.Option<"matroska" | "mp4"> => {
  const container = file.probe.container;

  if (container === "mkv" || container === "webm") return Option.some("matroska");

  return container === "mp4" || container === "mov" ? Option.some("mp4") : Option.none();
};

const keyOf = (file: ResolvedMediaFile): string =>
  `${file.fileId}:${file.sizeBytes}:${file.modifiedAtMs}`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;
  const scanTimeout = (yield* MediaConfig.Service).fileScanTimeout;
  const scope = yield* Effect.scope;

  const running = yield* Ref.make<Running>(new Map());

  const fromIndex = (path: string, read: "matroska" | "mp4", size: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path);

        const readAt = (position: number, length: number) =>
          file
            .readAlloc(length, { position: BigInt(position) })
            .pipe(Effect.map((bytes) => Option.getOrElse(bytes, () => new Uint8Array(0))));

        return read === "matroska"
          ? yield* readMatroskaKeyframes(readAt)
          : yield* readMp4Keyframes(readAt, size);
      }),
    );

  const fromPacketScan = Effect.fn("KeyframeIndex.packetScan")(function* (path: string) {
    const csv = yield* tools.ffprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
        path,
      ],
      { timeout: scanTimeout },
    );

    return parsePacketList(csv);
  });

  const index = Effect.fn("KeyframeIndex.index")(function* (file: ResolvedMediaFile) {
    const failed = (cause: unknown) => new KeyframeIndexFailed({ fileId: file.fileId, cause });
    const kind = indexKind(file);

    const indexed = Option.isSome(kind)
      ? yield* fromIndex(file.path, kind.value, file.sizeBytes).pipe(
          Effect.tapError((error) => Effect.logDebug("KeyframeIndex.index_unreadable", error)),
          Effect.orElseSucceed(() => Option.none<ReadonlyArray<number>>()),
        )
      : Option.none<ReadonlyArray<number>>();

    const times = Option.isSome(indexed)
      ? indexed.value
      : yield* fromPacketScan(file.path).pipe(Effect.mapError(failed));

    if (times.length === 0) return yield* failed("no keyframes");

    return times;
  });

  const lookup = Effect.fnUntraced(function* (file: ResolvedMediaFile) {
    const key = keyOf(file);
    const cached = yield* cache.read(CACHE_NAMESPACE, key, CACHE_MAX_AGE);

    if (Option.isSome(cached)) {
      const decoded = yield* decodeKeyframes(cached.value).pipe(Effect.option);

      if (Option.isSome(decoded) && decoded.value.length > 0) {
        return yield* Deferred.make<ReadonlyArray<number>, KeyframeIndexFailed>().pipe(
          Effect.tap((done) => Deferred.succeed(done, decoded.value)),
        );
      }
    }

    const fresh: Pending = yield* Deferred.make<ReadonlyArray<number>, KeyframeIndexFailed>();

    const scanInto = (deferred: Pending) =>
      index(file).pipe(
        Effect.tap((times) =>
          encodeKeyframes(times).pipe(
            Effect.orDie,
            Effect.flatMap((body) => cache.write(CACHE_NAMESPACE, key, body)),
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.done(deferred, exit).pipe(
            Effect.andThen(
              Ref.update(running, (current) => {
                const next = new Map(current);
                next.delete(key);

                return next;
              }),
            ),
            Effect.as(Exit.isSuccess(exit)),
          ),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const [deferred, started] = yield* Ref.modify(
          running,
          (current: Running): readonly [readonly [Pending, boolean], Running] => {
            const existing = current.get(key);

            return existing === undefined
              ? [[fresh, true], new Map(current).set(key, fresh)]
              : [[existing, false], current];
          },
        );

        if (started) yield* scanInto(deferred);

        return deferred;
      }),
    );
  });

  const keyframes = Effect.fn("KeyframeIndex.keyframes")(function* (file: ResolvedMediaFile) {
    return yield* Deferred.await(yield* lookup(file));
  });

  const keyframesWithin = Effect.fn("KeyframeIndex.keyframesWithin")(function* (
    file: ResolvedMediaFile,
    wait: Duration.Duration,
  ) {
    const deferred = yield* lookup(file);

    return yield* Deferred.await(deferred).pipe(Effect.timeoutOption(wait));
  });

  return Service.of({ keyframes, keyframesWithin });
});

/** The keyframe index over the platform file system, ffprobe, and the disk cache. */
export const layer: Layer.Layer<
  Service,
  never,
  FileSystem.FileSystem | MediaTools.Service | DiskCache.Service | MediaConfig.Service
> = Layer.effect(Service, make);
