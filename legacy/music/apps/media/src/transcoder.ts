/**
 * Transcodes tracks into a size-bounded cache under `MEDIA_DATA_DIR/cache`: fast-start AAC for
 * `<audio>`, and fragmented MP4 (FLAC or AAC) for the gapless MSE engine. A fragmented output has
 * a `.json` sidecar with its measured sample timing, written before the media file appears and
 * evicted with it. Concurrent
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
  Schema,
  Semaphore,
} from "effect";

import {
  AAC_TAIL_PADDING,
  aacSampleRate,
  countFrameSamples,
  fragmentedArgs,
  isFragmentedProfile,
  runTool,
  sourceProbeArgs,
  timelineProbeArgs,
  transcodeArgs,
  type FragmentedProfile,
  type ProcessError,
  type TranscodeProfile,
} from "./ffmpeg.ts";
import * as Files from "./files.ts";
import { MediaConfig } from "./media-config.ts";
import { declaredLength, measureTiming, SampleTiming } from "./sample-timing.ts";

const MAX_CONCURRENT_TRANSCODES = 2;

const TRANSCODE_TIMEOUT = Duration.minutes(10);

const PROFILES: ReadonlyArray<TranscodeProfile> = ["aac-320", "aac-128", "fmp4-flac", "fmp4-aac"];

const SIDECAR_SUFFIX = ".json";

const sidecarOf = (output: string): string => `${output}${SIDECAR_SUFFIX}`;

const TimelineProbe = Schema.Struct({
  streams: Schema.Tuple([
    Schema.Struct({ duration_ts: Schema.Finite, sample_rate: Schema.FiniteFromString }),
  ]),
});

const decodeTimelineProbe = Schema.decodeEffect(Schema.fromJsonString(TimelineProbe));

const SourceProbe = Schema.Struct({
  streams: Schema.Tuple([
    Schema.Struct({
      duration_ts: Schema.optionalKey(Schema.Finite),
      time_base: Schema.String,
      sample_rate: Schema.FiniteFromString,
    }),
  ]),
  format: Schema.Struct({ format_name: Schema.String }),
});

const decodeSourceProbe = Schema.decodeEffect(Schema.fromJsonString(SourceProbe));

const SidecarJson = Schema.fromJsonString(SampleTiming);

const decodeSidecar = Schema.decodeEffect(SidecarJson);

const encodeSidecar = Schema.encodeEffect(SidecarJson);

/** One source file version to transcode to one profile. */
interface TranscodeInput {
  readonly trackId: TrackId;
  readonly profile: TranscodeProfile;
  /** Absolute path of the source file. */
  readonly source: string;
  /** Source modification time; a changed file gets a new cache entry. */
  readonly mtimeMs: number;
  /** The scanner's normalized source codec (`flac`, `mp3`, ...); FLAC remuxes for `fmp4-flac`. */
  readonly codec: string;
}

/** A finished transcode. */
export interface Transcoded {
  readonly path: string;
  /** Measured sample timing; present exactly for the fragmented profiles. */
  readonly timing: Option.Option<SampleTiming>;
}

/** Transcoding failed or timed out. */
class TranscodeError extends Data.TaggedError("TranscodeError")<{
  readonly trackId: TrackId;
  readonly profile: TranscodeProfile;
  /** `timing`: ffmpeg's numbers did not add up to a plausible priming and length. */
  readonly cause: ProcessError | Files.FileError | Schema.SchemaError | "timeout" | "timing";
}> {
  override get message(): string {
    return `Transcode failed: track ${this.trackId} to ${this.profile}`;
  }
}

/** Transcoded files on demand. */
export interface Interface {
  /** Returns the cached transcode, creating it first when needed. */
  readonly transcode: (input: TranscodeInput) => Effect.Effect<Transcoded, TranscodeError>;
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

  // Sidecars go with their media file, so only media files are candidates.
  const files = listed
    .flat()
    .filter((file) => !file.path.endsWith(".part") && !file.path.endsWith(SIDECAR_SUFFIX));

  let total = files.reduce((sum, file) => sum + file.size, 0);

  if (total <= maxBytes) return;

  const usedAt = (file: { readonly path: string; readonly mtimeMs: number }): number =>
    lastUsed.get(file.path) ?? file.mtimeMs;

  const oldestFirst = files.toSorted((left, right) => usedAt(left) - usedAt(right));

  for (const file of oldestFirst) {
    if (total <= maxBytes) break;

    if (file.path !== keep) {
      yield* Files.removePath(sidecarOf(file.path));
      yield* Files.removePath(file.path);
      total -= file.size;
      yield* Effect.logInfo("Transcoder.evicted").pipe(Effect.annotateLogs({ bytes: file.size }));
    }
  }
});

/** The cached output of `input`, when its media file (and sidecar, if any) are complete. */
const cached = (output: string, input: TranscodeInput): Effect.Effect<Option.Option<Transcoded>> =>
  Effect.gen(function* () {
    yield* Files.statPath(output);

    if (!isFragmentedProfile(input.profile)) {
      return Option.some({ path: output, timing: Option.none() });
    }

    const sidecar = yield* Files.readWholeFile(sidecarOf(output));
    const timing = yield* decodeSidecar(new TextDecoder().decode(sidecar));

    return Option.some({ path: output, timing: Option.some(timing) });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

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

  /** Writes a fragmented transcode to `temporary` and measures its timing. */
  const encodeFragmented = Effect.fn("Transcoder.encodeFragmented")(function* (
    input: TranscodeInput,
    profile: FragmentedProfile,
    temporary: string,
  ) {
    const sourceProbed = yield* runTool(config.ffprobePath, sourceProbeArgs(input.source));

    const {
      streams: [sourceStream],
      format,
    } = yield* decodeSourceProbe(sourceProbed.stdout);

    const encoded = yield* runTool(
      config.ffmpegPath,
      fragmentedArgs(
        input.source,
        temporary,
        profile,
        input.codec,
        aacSampleRate(sourceStream.sample_rate),
      ),
    );

    const probed = yield* runTool(config.ffprobePath, timelineProbeArgs(temporary));

    const {
      streams: [stream],
    } = yield* decodeTimelineProbe(probed.stdout);

    const timing = measureTiming(
      stream.duration_ts,
      countFrameSamples(encoded.stdout),
      profile === "fmp4-aac" ? AAC_TAIL_PADDING : 0,
      stream.sample_rate,
      declaredLength(
        format.format_name,
        sourceStream.duration_ts,
        sourceStream.time_base,
        stream.sample_rate,
      ),
    );

    if (Option.isNone(timing)) return yield* Effect.fail("timing" as const);

    return timing.value;
  });

  const produce = Effect.fn("Transcoder.produce")(function* (key: CacheKey) {
    const { output, input } = key;
    const now = yield* Clock.currentTimeMillis;
    const existing = yield* cached(output, input);

    if (Option.isSome(existing)) {
      yield* markUsed(output, now);

      return existing.value;
    }

    const temporary = `${output}.${randomUUID()}.part`;
    const profile = input.profile;

    const run = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      let timing: Option.Option<SampleTiming> = Option.none();

      if (isFragmentedProfile(profile)) {
        const measured = yield* encodeFragmented(input, profile, temporary);
        const json = yield* encodeSidecar(measured);

        // The sidecar lands first: a media file without one is never served as finished.
        yield* Files.writeFileAtomic(
          sidecarOf(output),
          new TextEncoder().encode(json),
          randomUUID(),
        );

        timing = Option.some(measured);
      } else {
        yield* runTool(config.ffmpegPath, transcodeArgs(input.source, temporary, profile));
      }

      yield* Files.renameFile(temporary, output);
      const finished = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("Transcoder.transcoded").pipe(
        Effect.annotateLogs({
          trackId: input.trackId,
          profile,
          ms: finished - started,
        }),
      );

      return { path: output, timing };
    }).pipe(
      Effect.onError(() => Files.removePath(temporary).pipe(Effect.ignore)),
      permits.withPermits(1),
    );

    const transcoded = yield* run.pipe(
      Effect.timeoutOrElse({
        duration: TRANSCODE_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
    );

    yield* markUsed(output, yield* Clock.currentTimeMillis);
    yield* evictNow(output);

    return transcoded;
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
