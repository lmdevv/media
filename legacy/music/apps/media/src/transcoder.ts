/**
 * Transcodes tracks to AAC into a size-bounded cache under `MEDIA_DATA_DIR/cache`. Concurrent
 * requests for the same output share one ffmpeg run, at most two ffmpeg runs happen at once, and
 * the least recently served files are evicted when the cache grows past its limit.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { TrackId } from "@music/commands/ids";
import {
  Cache,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Equal,
  Hash,
  Layer,
  Option,
  Ref,
  Semaphore,
} from "effect";

import { transcodeArgs, runTool, type ProcessError, type TranscodeProfile } from "./ffmpeg.ts";
import * as Files from "./files.ts";
import { MediaConfig } from "./media-config.ts";

const MAX_CONCURRENT_TRANSCODES = 2;

const TRANSCODE_TIMEOUT = Duration.minutes(10);

const PROFILES: ReadonlyArray<TranscodeProfile> = ["aac-320", "aac-128"];

/** One source file version to transcode to one profile. */
interface TranscodeInput {
  readonly trackId: TrackId;
  readonly profile: TranscodeProfile;
  /** Absolute path of the source file. */
  readonly source: string;
  /** Source modification time; a changed file gets a new cache entry. */
  readonly mtimeMs: number;
}

/** Transcoding failed or timed out. */
class TranscodeError extends Data.TaggedError("TranscodeError")<{
  readonly trackId: TrackId;
  readonly profile: TranscodeProfile;
  readonly cause: ProcessError | Files.FileError | "timeout";
}> {
  override get message(): string {
    return `Transcode failed: track ${this.trackId} to ${this.profile}`;
  }
}

/** Transcoded files on demand. */
export interface Interface {
  /** Returns the path of the cached transcode, creating it first when needed. */
  readonly transcode: (input: TranscodeInput) => Effect.Effect<string, TranscodeError>;
  /** True when ffmpeg runs. Cached for a minute. */
  readonly ffmpegAvailable: Effect.Effect<boolean>;
}

/** The transcode cache. */
export class Transcoder extends Context.Service<Transcoder, Interface>()(
  "@music/media/Transcoder",
) {}

/** Identifies an in-flight transcode by its output path alone. */
class CacheKey implements Equal.Equal {
  readonly output: string;
  readonly input: TranscodeInput;

  constructor(output: string, input: TranscodeInput) {
    this.output = output;
    this.input = input;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof CacheKey && that.output === this.output;
  }

  [Hash.symbol](): number {
    return Hash.string(this.output);
  }
}

/**
 * Deletes the least recently used files until the cache fits in `maxBytes`. `lastUsed` holds the
 * serve times seen by this process; older files fall back to their modification time. Files are
 * never touched to record use, because their modification time feeds the `ETag` players send
 * back in `If-Range`.
 */
const evict = Effect.fn("Transcoder.evict")(function* (
  cacheDir: string,
  maxBytes: number,
  keep: string,
  lastUsed: ReadonlyMap<string, number>,
) {
  const listed = yield* Effect.forEach(PROFILES, (profile) =>
    Files.listFiles(join(cacheDir, profile)),
  );

  const files = listed.flat().filter((file) => !file.path.endsWith(".part"));
  let total = files.reduce((sum, file) => sum + file.size, 0);

  if (total <= maxBytes) return;

  const usedAt = (file: { readonly path: string; readonly mtimeMs: number }): number =>
    lastUsed.get(file.path) ?? file.mtimeMs;

  const oldestFirst = files.toSorted((left, right) => usedAt(left) - usedAt(right));

  for (const file of oldestFirst) {
    if (total <= maxBytes) break;

    if (file.path !== keep) {
      yield* Files.removePath(file.path);
      total -= file.size;
      yield* Effect.logInfo("Transcoder.evicted").pipe(Effect.annotateLogs({ bytes: file.size }));
    }
  }
});

/** Builds the transcoder from configuration. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig;
  const cacheDir = join(config.dataDir, "cache");
  const permits = yield* Semaphore.make(MAX_CONCURRENT_TRANSCODES);
  const lastUsed = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const markUsed = (output: string, at: number): Effect.Effect<void> =>
    Ref.update(lastUsed, (current) => new Map(current).set(output, at));

  const evictNow = (keep: string): Effect.Effect<void> =>
    Ref.get(lastUsed).pipe(
      Effect.flatMap((used) => evict(cacheDir, config.cacheMaxBytes, keep, used)),
      Effect.catchTag("FileError", (error) => Effect.logWarning("Transcoder.evict_failed", error)),
    );

  yield* Effect.forEach(PROFILES, (profile) => Files.makeDirectory(join(cacheDir, profile))).pipe(
    Effect.orDie,
  );
  yield* evictNow("");

  const produce = Effect.fn("Transcoder.produce")(function* (key: CacheKey) {
    const { output, input } = key;
    const now = yield* Clock.currentTimeMillis;
    const existing = yield* Files.statPath(output).pipe(Effect.option);

    if (Option.isSome(existing)) {
      yield* markUsed(output, now);

      return output;
    }

    const temporary = `${output}.${randomUUID()}.part`;

    const run = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* runTool(config.ffmpegPath, transcodeArgs(input.source, temporary, input.profile));
      yield* Files.renameFile(temporary, output);
      const finished = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("Transcoder.transcoded").pipe(
        Effect.annotateLogs({
          trackId: input.trackId,
          profile: input.profile,
          ms: finished - started,
        }),
      );
    }).pipe(
      Effect.onError(() => Files.removePath(temporary).pipe(Effect.ignore)),
      permits.withPermits(1),
    );

    yield* run.pipe(
      Effect.timeoutOrElse({
        duration: TRANSCODE_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
    );

    yield* markUsed(output, yield* Clock.currentTimeMillis);
    yield* evictNow(output);

    return output;
  });

  const inFlight = yield* Cache.makeWith(
    (key: CacheKey) =>
      produce(key).pipe(
        Effect.mapError(
          (cause) =>
            new TranscodeError({ trackId: key.input.trackId, profile: key.input.profile, cause }),
        ),
      ),
    // Entries expire as soon as they settle: the cache only joins concurrent requests for the
    // same output. Finished files are found on disk by the next request.
    { capacity: 1024, timeToLive: () => Duration.zero },
  );

  const ffmpegAvailable = yield* Effect.cachedWithTTL(
    runTool(config.ffmpegPath, ["-hide_banner", "-version"]).pipe(
      Effect.as(true),
      Effect.catchTag("ProcessError", () => Effect.succeed(false)),
    ),
    Duration.minutes(1),
  );

  return Transcoder.of({
    transcode: Effect.fn("Transcoder.transcode")(function* (input: TranscodeInput) {
      const output = join(
        cacheDir,
        input.profile,
        `${input.trackId}-${Math.trunc(input.mtimeMs)}.m4a`,
      );

      return yield* Cache.get(inFlight, new CacheKey(output, input));
    }),
    ffmpegAvailable,
  });
});

/** The transcoder, configured by `MediaConfig`. */
export const layer: Layer.Layer<Transcoder, never, MediaConfig> = Layer.effect(Transcoder, make);
