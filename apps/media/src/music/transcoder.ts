/**
 * Music's transcodes, as old music's media service ran them (`transcoder.ts`): one cached
 * transcode per song version and profile, shared by everyone who asks for it and readable while
 * ffmpeg still writes it; a background lane that prepares the finished file for a client that
 * polls; and fresh encodes from an offset for a listener who seeks ahead. They run under music's
 * own caps, not the server's video transcode limit (ADR 0014), and write only under `DATA_DIR`'s
 * cache, which the cache pruner keeps within `CACHE_MAX_MB`.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { TrackId } from "@media/contracts/ids";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  type Scope,
  Semaphore,
  Sink,
  Stream,
  SubscriptionRef,
} from "effect";

import { markUsed } from "../cache-pruner.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { MediaToolFailed } from "../media/media-tools.ts";
import * as MediaConfig from "../media-config.ts";
import {
  AAC_PRIMING,
  AAC_PROFILE_RATE,
  AAC_TAIL_PADDING,
  aacSampleRate,
  FRAGMENTED_PRIMING,
  FrameSampleCount,
  fragmentedArgs,
  isFragmentedProfile,
  offsetArgs,
  sourceProbeArgs,
  timelineProbeArgs,
  transcodeArgs,
  type FragmentedProfile,
  type TranscodeProfile,
} from "./ffmpeg-args.ts";
import { type FragmentTimelineError, shiftTimeline, timelineStart } from "./fragment-timeline.ts";
import * as Files from "./music-files.ts";
import { runPiped, streamPiped } from "./music-tools.ts";
import { declaredLength, estimatedLength, measureTiming, SampleTiming } from "./sample-timing.ts";

const MAX_CONCURRENT_TRANSCODES = 2;

const PREPARE_RUNS = 1;

/**
 * How long a detached run is held while nobody asks about it; then it stops like a stream nobody
 * reads. Well past a poller's `PREPARE_RETRY` and shorter than `TRANSCODE_TIMEOUT`, so a client
 * that gave up frees the prepare lane before the run would time out.
 */
export const PREPARE_HOLD = Duration.minutes(2);

const PREPARE_RETRY = Duration.seconds(2);

/** How long the failure of a detached run is reported; asking after that starts a new run. */
export const PREPARE_FAILURE_TTL = Duration.minutes(1);

/**
 * Offset runs (`openAt`) skip the cached transcodes' queue so a seek never waits behind other
 * songs; this caps them on their own. A player needs one at a time per playing device.
 */
const MAX_CONCURRENT_OFFSET_RUNS = 8;

const TRANSCODE_TIMEOUT = Duration.minutes(10);

const ABANDON_GRACE = Duration.seconds(1);

const PROFILES: ReadonlyArray<TranscodeProfile> = ["aac-320", "aac-128", "fmp4-flac", "fmp4-aac"];

const SIDECAR_SUFFIX = ".json";

const PARTIAL_SUFFIX = ".part";

const LIVE_CHUNK_BYTES = 256 * 1024;

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
  format: Schema.Struct({
    format_name: Schema.String,
    duration: Schema.optionalKey(Schema.FiniteFromString),
  }),
});

const decodeSourceProbe = Schema.decodeEffect(Schema.fromJsonString(SourceProbe));

const SidecarJson = Schema.fromJsonString(SampleTiming);

const decodeSidecar = Schema.decodeEffect(SidecarJson);

const encodeSidecar = Schema.encodeEffect(SidecarJson);

/** One source file version to transcode to one profile. */
export interface TranscodeInput {
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

/** Transcoding failed, timed out, or stopped. */
export class TranscodeError extends Data.TaggedError("TranscodeError")<{
  readonly trackId: TrackId;
  readonly profile: TranscodeProfile;
  /**
   * `timing`: ffmpeg's numbers did not add up to a plausible priming and length. `stopped`: the
   * service shut down mid-transcode.
   */
  readonly cause:
    | MediaToolFailed
    | FragmentTimelineError
    | Files.FileError
    | Schema.SchemaError
    | "timeout"
    | "timing"
    | "stopped";
}> {
  override get message(): string {
    return `Transcode failed: track ${this.trackId} to ${this.profile}`;
  }
}

/** Every offset run is taken; the request fails at once rather than queueing behind streams. */
class OffsetRunsBusy extends Data.TaggedError("OffsetRunsBusy")<{}> {
  override get message(): string {
    return "Too many offset transcodes are running";
  }
}

/** What `open` found: a finished file, or a transcode ffmpeg is still writing. */
export type Opened = Data.TaggedEnum<{
  Finished: { readonly transcoded: Transcoded };
  Live: {
    /**
     * Present exactly for the fragmented profiles: timing known before encoding, with the exact
     * priming and sample rate and a `durationSamples` estimated from the source's declared
     * length. The finished file carries the measured one.
     */
    readonly timing: Option.Option<SampleTiming>;
    /**
     * The stream from its first byte as ffmpeg writes it. Fragmented profiles: `ftyp`, `moov`,
     * then fragments, with no `sidx` and no `mfra` (the finished file has both, so its byte
     * offsets differ). AAC profiles: ADTS, while the finished file is an MP4. Ends once the
     * finished file is in the cache; fails when the transcode fails.
     */
    readonly bytes: Stream.Stream<Uint8Array, TranscodeError>;
    /** Waits for the finished transcode. */
    readonly finished: Effect.Effect<Transcoded, TranscodeError>;
  };
}>;

/** Constructors and matchers for `Opened`. */
export const Opened = Data.taggedEnum<Opened>();

/** What `prepare` found: the finished file, a run still going, or a run that failed just now. */
export type Prepared = Data.TaggedEnum<{
  Ready: { readonly transcoded: Transcoded };
  /** Encoding, or waiting for the prepare lane, in the background; ask again after `retryAfter`. */
  Pending: { readonly retryAfter: Duration.Duration };
  /** The detached run failed less than `PREPARE_FAILURE_TTL` ago. */
  Failed: { readonly error: TranscodeError };
}>;

/** Constructors and matchers for `Prepared`. */
export const Prepared = Data.taggedEnum<Prepared>();

/**
 * A transcode that starts part-way into the song, encoded for one listener and never cached.
 *
 * Timeline: the stream begins at song sample `startSamples` (at `sampleRate`), preceded by
 * `primingSamples` of encoder delay.
 *
 * - AAC profiles: ADTS, which carries no timestamps; the decoded audio starts with the priming,
 *   so playback position `t` seconds in the stream is song sample
 *   `startSamples - primingSamples + t * sampleRate`.
 * - Fragmented profiles: `ftyp`, `moov`, then fragments (no `sidx`, no `mfra`) on the song's own
 *   timeline, as in the full stream: the first fragment's decode time (`tfdt`) is
 *   `startSamples`, so song sample `s` sits at timeline position `s + primingSamples` exactly
 *   where the full transcode has it. The `moov` describes this encode (for `fmp4-flac` its FLAC
 *   stream info may differ from the full stream's), so a player appends it before the fragments.
 */
interface FromOffset {
  readonly startSamples: number;
  readonly primingSamples: number;
  readonly sampleRate: number;
  /** The song's estimated length in samples, from the source probe (fragmented profiles only). */
  readonly durationSamples: Option.Option<number>;
  /**
   * The stream from its first byte. ffmpeg runs only while it is read and stops when the scope
   * closes; it fails when ffmpeg fails.
   */
  readonly bytes: Stream.Stream<Uint8Array, TranscodeError>;
}

/** Transcoded files on demand. */
export interface Interface {
  /** Returns the cached transcode, creating it first when needed. */
  readonly transcode: (input: TranscodeInput) => Effect.Effect<Transcoded, TranscodeError>;
  /**
   * Starts or joins the transcode of `input` and returns as soon as it can be read: the cached
   * file, or the live transcode once ffmpeg has written its first bytes. Fails when the
   * transcode fails before that. A live transcode stays readable until the
   * scope closes; once every scope holding a transcode has closed, it stops after a second.
   */
  readonly open: (input: TranscodeInput) => Effect.Effect<Opened, TranscodeError, Scope.Scope>;
  /**
   * Starts a transcode of `input` from `startMs` into the song, for a listener who seeks ahead of
   * the shared transcode, and returns once ffmpeg has written its first bytes (the stream is
   * empty when the offset is past the end). Not cached, not shared, and outside the limit on
   * concurrent cached transcodes, so a seek never queues behind other songs; offset runs have
   * their own limit, held until `Scope` closes. Fails when ffmpeg fails before its first byte,
   * and with `OffsetRunsBusy` when every offset run is taken.
   */
  readonly openAt: (
    input: TranscodeInput,
    startMs: number,
  ) => Effect.Effect<FromOffset, TranscodeError | OffsetRunsBusy, Scope.Scope>;
  /**
   * Returns the cached transcode of `input`, or starts or joins its transcode detached from the
   * caller and returns `Pending`. A detached run is held until it finishes or nobody has asked
   * about it for `PREPARE_HOLD`. New detached runs take the prepare lane, `PREPARE_RUNS` at once
   * and never a shared slot; while the lane is taken, `prepare` returns `Pending` without starting
   * one, and a later ask starts it. A held run's failure is returned for `PREPARE_FAILURE_TTL`.
   */
  readonly prepare: (input: TranscodeInput) => Effect.Effect<Prepared>;
}

/** The transcode cache. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/MusicTranscoder",
) {}

const failure = (input: TranscodeInput) => (cause: TranscodeError["cause"]) =>
  new TranscodeError({ trackId: input.trackId, profile: input.profile, cause });

type Progress = Data.TaggedEnum<{
  Queued: {};
  Writing: { readonly timing: Option.Option<SampleTiming>; readonly written: number };
  Finished: { readonly transcoded: Transcoded; readonly written: number };
  Failed: { readonly error: TranscodeError };
}>;

const Progress = Data.taggedEnum<Progress>();

interface Job {
  readonly output: string;
  readonly lane: Semaphore.Semaphore;
  readonly live: string;
  readonly progress: SubscriptionRef.SubscriptionRef<Progress>;
  readonly holds: Ref.Ref<{ readonly readers: number; readonly settled: boolean }>;
  readonly fiber: Deferred.Deferred<Fiber.Fiber<void>>;
}

type LivePage = readonly [ReadonlyArray<Uint8Array>, Option.Option<number>];

const writtenOf = (progress: Progress): number =>
  Progress.$match(progress, {
    Queued: () => 0,
    Writing: ({ written }) => written,
    Finished: ({ written }) => written,
    Failed: () => 0,
  });

const awaitProgress = <A, E>(
  job: Job,
  select: (progress: Progress) => Result.Result<Effect.Effect<A, E>, Progress>,
): Effect.Effect<A, E> =>
  SubscriptionRef.changes(job.progress).pipe(
    Stream.filterMap(select),
    Stream.runHead,
    Effect.flatMap(Option.getOrThrow),
  );

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

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const cacheDir = join(config.dataDir, "cache", "music");
  /**
   * Where every file a transcode writes before it is finished lives: its output, its live copy,
   * and its timing. The cache pruner prunes `DATA_DIR/cache` by size, recent files included, so a
   * file still being written stays out of its reach and moves into the cache once it is whole.
   */
  const workDir = join(config.dataDir, "music", "transcoding");
  const workFile = (suffix: string): string => join(workDir, `${randomUUID()}${suffix}`);
  const permits = yield* Semaphore.make(MAX_CONCURRENT_TRANSCODES);
  const prepareLane = yield* Semaphore.make(PREPARE_RUNS);
  const offsetRuns = yield* Semaphore.make(MAX_CONCURRENT_OFFSET_RUNS);
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map());
  const registry = yield* Semaphore.make(1);
  const preparing = new Map<string, { readonly job: Job; readonly askedAt: number }>();
  const failures = new Map<string, { readonly error: TranscodeError; readonly until: number }>();

  /**
   * Marks a cached transcode and its timing as used now, so the cache pruner, which removes the
   * least recently used files first, keeps the songs people play.
   */
  const markPlayed = (output: string): Effect.Effect<void> =>
    Effect.forEach([output, sidecarOf(output)], (file) => markUsed(file), { discard: true }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.ignore,
    );

  // What an earlier run left half written goes; no transcode runs yet.
  yield* Files.removePath(workDir).pipe(
    Effect.andThen(Files.makeDirectory(workDir)),
    Effect.andThen(
      Effect.forEach(PROFILES, (profile) => Files.makeDirectory(join(cacheDir, profile))),
    ),
    Effect.orDie,
  );

  const appendLive = (job: Job, chunk: Uint8Array) =>
    Files.appendToFile(job.live, chunk).pipe(
      Effect.andThen(
        SubscriptionRef.update(job.progress, (progress) =>
          Progress.$is("Writing")(progress)
            ? Progress.Writing({
                timing: progress.timing,
                written: progress.written + chunk.length,
              })
            : progress,
        ),
      ),
    );

  const startLive = (job: Job, timing: Option.Option<SampleTiming>) =>
    Files.appendToFile(job.live, new Uint8Array()).pipe(
      Effect.andThen(SubscriptionRef.set(job.progress, Progress.Writing({ timing, written: 0 }))),
    );

  const encodeFragmented = Effect.fn("Transcoder.encodeFragmented")(function* (
    job: Job,
    input: TranscodeInput,
    profile: FragmentedProfile,
    temporary: string,
  ) {
    const sourceProbed = yield* tools.ffprobe(sourceProbeArgs(input.source));

    const {
      streams: [sourceStream],
      format,
    } = yield* decodeSourceProbe(sourceProbed);

    const aacRate = aacSampleRate(sourceStream.sample_rate);
    const outputRate = profile === "fmp4-aac" ? aacRate : sourceStream.sample_rate;

    const expected: SampleTiming = {
      primingSamples: FRAGMENTED_PRIMING[profile],
      durationSamples: estimatedLength(
        sourceStream.duration_ts,
        sourceStream.time_base,
        format.duration,
        outputRate,
      ),
      sampleRate: outputRate,
    };

    yield* startLive(job, Option.some(expected));
    const decoded = new FrameSampleCount();

    yield* runPiped(
      tools,
      fragmentedArgs(input.source, temporary, profile, input.codec, aacRate),
      (chunk) => appendLive(job, chunk),
      (listing) => {
        decoded.push(listing);
      },
    );

    const probed = yield* tools.ffprobe(timelineProbeArgs(temporary));

    const {
      streams: [stream],
    } = yield* decodeTimelineProbe(probed);

    const timing = measureTiming(
      stream.duration_ts,
      decoded.total(),
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

    if (
      timing.value.primingSamples !== expected.primingSamples ||
      timing.value.sampleRate !== expected.sampleRate
    ) {
      yield* Effect.logError("Transcoder.unexpected_timing").pipe(
        Effect.annotateLogs({ trackId: input.trackId, profile, expected, measured: timing.value }),
      );
    }

    return timing.value;
  });

  const produce = Effect.fn("Transcoder.produce")(function* (job: Job, input: TranscodeInput) {
    const temporary = workFile(PARTIAL_SUFFIX);
    const profile = input.profile;

    const run = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      let timing: Option.Option<SampleTiming> = Option.none();

      if (isFragmentedProfile(profile)) {
        const measured = yield* encodeFragmented(job, input, profile, temporary);
        const json = yield* encodeSidecar(measured);

        const timingFile = workFile(SIDECAR_SUFFIX);

        yield* Files.writeFileAtomic(timingFile, new TextEncoder().encode(json), randomUUID());
        yield* Files.renameFile(timingFile, sidecarOf(job.output));

        timing = Option.some(measured);
      } else {
        yield* startLive(job, Option.none());
        yield* runPiped(tools, transcodeArgs(input.source, temporary, profile), (chunk) =>
          appendLive(job, chunk),
        );
      }

      yield* Files.renameFile(temporary, job.output);
      const finished = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("Transcoder.transcoded").pipe(
        Effect.annotateLogs({
          trackId: input.trackId,
          profile,
          ms: finished - started,
        }),
      );

      return { path: job.output, timing };
    }).pipe(
      Effect.timeoutOrElse({
        duration: TRANSCODE_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
      Effect.onError(() => Files.removePath(temporary).pipe(Effect.ignore)),
      job.lane.withPermits(1),
    );

    return yield* run;
  });

  const deleteLive = (job: Job): Effect.Effect<void> =>
    Files.removePath(job.live).pipe(Effect.ignore);

  const unregister = (job: Job): Effect.Effect<void> =>
    Ref.update(jobs, (current) => {
      if (current.get(job.output) !== job) return current;
      const next = new Map(current);
      next.delete(job.output);

      return next;
    });

  const settle = (job: Job, input: TranscodeInput, exit: Exit.Exit<Transcoded, TranscodeError>) =>
    Effect.gen(function* () {
      yield* registry.withPermits(1)(unregister(job));

      const unused = yield* Ref.modify(job.holds, (holds) => [
        holds.readers === 0,
        { ...holds, settled: true },
      ]);

      if (unused) yield* deleteLive(job);
      const written = writtenOf(yield* SubscriptionRef.get(job.progress));

      yield* SubscriptionRef.set(
        job.progress,
        Exit.match(exit, {
          onSuccess: (transcoded) => Progress.Finished({ transcoded, written }),
          onFailure: (cause) =>
            Progress.Failed({
              error: Option.getOrElse(Cause.findErrorOption(cause), () =>
                failure(input)("stopped"),
              ),
            }),
        }),
      );
    });

  const release = (job: Job) =>
    Ref.modify(job.holds, (holds) => {
      const readers = holds.readers - 1;

      return [
        { readers, settled: holds.settled },
        { ...holds, readers },
      ] as const;
    }).pipe(
      Effect.flatMap(({ readers, settled }) => {
        if (readers > 0) return Effect.void;

        if (settled) return deleteLive(job);

        return stopIfAbandoned(job).pipe(Effect.delay(ABANDON_GRACE), Effect.forkIn(scope));
      }),
    );

  const stopIfAbandoned = (job: Job) =>
    registry
      .withPermits(1)(
        Ref.get(job.holds).pipe(
          Effect.flatMap((holds) =>
            holds.readers === 0 && !holds.settled
              ? unregister(job).pipe(Effect.as(true))
              : Effect.succeed(false),
          ),
        ),
      )
      .pipe(
        Effect.flatMap((abandoned) =>
          abandoned ? Deferred.await(job.fiber).pipe(Effect.flatMap(Fiber.interrupt)) : Effect.void,
        ),
      );

  const hold = (job: Job) =>
    Effect.acquireRelease(
      Ref.update(job.holds, (holds) => ({ ...holds, readers: holds.readers + 1 })),
      () => release(job),
    );

  const start = Effect.fn("Transcoder.start")(function* (
    input: TranscodeInput,
    output: string,
    lane: Semaphore.Semaphore,
  ) {
    const job: Job = {
      output,
      lane,
      live: workFile(`.live${PARTIAL_SUFFIX}`),
      progress: yield* SubscriptionRef.make<Progress>(Progress.Queued()),
      holds: yield* Ref.make({ readers: 0, settled: false }),
      fiber: yield* Deferred.make<Fiber.Fiber<void>>(),
    };

    yield* Ref.update(jobs, (current) => new Map(current).set(output, job));

    const fiber = yield* produce(job, input).pipe(
      Effect.mapError(failure(input)),
      Effect.onExit((exit) => settle(job, input, exit)),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    yield* Deferred.succeed(job.fiber, fiber);

    return job;
  });

  const readLive = (job: Job, input: TranscodeInput, position: number, available: number) =>
    Files.readAt(job.live, position, Math.min(LIVE_CHUNK_BYTES, available - position)).pipe(
      Effect.flatMap((bytes) =>
        bytes.length === 0
          ? Effect.fail(
              new Files.FileError({
                operation: "readLive",
                path: job.live,
                missing: false,
                cause: null,
              }),
            )
          : Effect.succeed([[bytes], Option.some(position + bytes.length)] as const),
      ),
      Effect.mapError(failure(input)),
    );

  const liveBytes = (job: Job, input: TranscodeInput): Stream.Stream<Uint8Array, TranscodeError> =>
    Stream.paginate(0, (position: number) =>
      awaitProgress<LivePage, TranscodeError>(job, (progress) =>
        Progress.$match(progress, {
          Queued: () => Result.fail(progress),
          Writing: ({ written }) =>
            written > position
              ? Result.succeed(readLive(job, input, position, written))
              : Result.fail(progress),
          Finished: ({ written }) =>
            Result.succeed(
              written > position
                ? readLive(job, input, position, written)
                : Effect.succeed([[], Option.none<number>()] as const),
            ),
          Failed: ({ error }) => Result.succeed(Effect.fail(error)),
        }),
      ),
    );

  const finishedOf = (job: Job): Effect.Effect<Transcoded, TranscodeError> =>
    awaitProgress<Transcoded, TranscodeError>(job, (progress) =>
      Progress.$match(progress, {
        Queued: () => Result.fail(progress),
        Writing: () => Result.fail(progress),
        Finished: ({ transcoded }) => Result.succeed(Effect.succeed(transcoded)),
        Failed: ({ error }) => Result.succeed(Effect.fail(error)),
      }),
    );

  const outputOf = (input: TranscodeInput): string =>
    join(cacheDir, input.profile, `${input.trackId}-${Math.trunc(input.mtimeMs)}.m4a`);

  const open = Effect.fn("Transcoder.open")(function* (input: TranscodeInput) {
    const output = outputOf(input);

    const found = yield* registry.withPermits(1)(
      Effect.gen(function* () {
        const running = (yield* Ref.get(jobs)).get(output);

        if (running !== undefined) {
          yield* hold(running);

          return Result.succeed(running);
        }

        const existing = yield* cached(output, input);

        if (Option.isSome(existing)) return Result.fail(existing.value);
        const job = yield* start(input, output, permits);
        yield* hold(job);

        return Result.succeed(job);
      }),
    );

    if (Result.isFailure(found)) {
      yield* markPlayed(output);

      return Opened.Finished({ transcoded: found.failure });
    }

    const job = found.success;

    return yield* awaitProgress<Opened, TranscodeError>(job, (progress) =>
      Progress.$match(progress, {
        Queued: () => Result.fail(progress),
        Writing: ({ timing, written }) =>
          written > 0
            ? Result.succeed(
                Effect.succeed(
                  Opened.Live({
                    timing,
                    bytes: liveBytes(job, input),
                    finished: finishedOf(job),
                  }),
                ),
              )
            : Result.fail(progress),
        Finished: ({ transcoded }) =>
          Result.succeed(Effect.succeed(Opened.Finished({ transcoded }))),
        Failed: ({ error }) => Result.succeed(Effect.fail(error)),
      }),
    );
  });

  const quietFor = (job: Job): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const held = preparing.get(job.output);

        if (held?.job !== job) return Effect.void;
        const remaining = held.askedAt + Duration.toMillis(PREPARE_HOLD) - now;

        return remaining > 0
          ? Effect.sleep(Duration.millis(remaining)).pipe(Effect.andThen(quietFor(job)))
          : Effect.void;
      }),
    );

  const unprepare = (job: Job, failed: Option.Option<TranscodeError>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        registry.withPermits(1)(
          Effect.sync(() => {
            if (preparing.get(job.output)?.job === job) preparing.delete(job.output);

            if (Option.isNone(failed)) return;

            for (const [output, { until }] of failures) if (until <= now) failures.delete(output);
            failures.set(job.output, {
              error: failed.value,
              until: now + Duration.toMillis(PREPARE_FAILURE_TTL),
            });
          }),
        ),
      ),
    );

  const holdForPrepare = (job: Job, now: number) =>
    Effect.gen(function* () {
      const held = preparing.get(job.output)?.job === job;

      preparing.set(job.output, { job, askedAt: now });

      if (held) return;

      yield* Ref.update(job.holds, (holds) => ({ ...holds, readers: holds.readers + 1 }));
      yield* Effect.raceFirst(
        finishedOf(job).pipe(
          Effect.match({ onFailure: Option.some, onSuccess: () => Option.none() }),
        ),
        quietFor(job).pipe(Effect.as(Option.none<TranscodeError>())),
      ).pipe(
        Effect.flatMap((failed) => unprepare(job, failed)),
        Effect.ensuring(release(job)),
        Effect.forkIn(scope),
      );
    });

  const prepare = Effect.fn("Transcoder.prepare")(function* (input: TranscodeInput) {
    const output = outputOf(input);
    const now = yield* Clock.currentTimeMillis;
    const pending = Prepared.Pending({ retryAfter: PREPARE_RETRY });

    const prepared = yield* registry.withPermits(1)(
      Effect.gen(function* () {
        const running = yield* Ref.get(jobs);
        const job = running.get(output);

        if (job !== undefined) {
          yield* holdForPrepare(job, now);

          return pending;
        }

        const existing = yield* cached(output, input);

        if (Option.isSome(existing)) return Prepared.Ready({ transcoded: existing.value });
        const failed = failures.get(output);

        if (failed !== undefined && failed.until > now) {
          return Prepared.Failed({ error: failed.error });
        }

        failures.delete(output);

        const detached = [...running.values()].filter((other) => other.lane === prepareLane);

        if (detached.length < PREPARE_RUNS) {
          yield* holdForPrepare(yield* start(input, output, prepareLane), now);
        }

        return pending;
      }),
    );

    if (Prepared.$is("Ready")(prepared)) yield* markPlayed(output);

    return prepared;
  });

  const offsetTiming = Effect.fn("Transcoder.offsetTiming")(function* (input: TranscodeInput) {
    if (!isFragmentedProfile(input.profile)) {
      return {
        sampleRate: AAC_PROFILE_RATE,
        aacRate: AAC_PROFILE_RATE,
        primingSamples: AAC_PRIMING,
        durationSamples: Option.none<number>(),
      };
    }

    const probed = yield* tools.ffprobe(sourceProbeArgs(input.source));

    const {
      streams: [sourceStream],
      format,
    } = yield* decodeSourceProbe(probed);

    const aacRate = aacSampleRate(sourceStream.sample_rate);
    const sampleRate = input.profile === "fmp4-aac" ? aacRate : sourceStream.sample_rate;

    return {
      sampleRate,
      aacRate,
      primingSamples: FRAGMENTED_PRIMING[input.profile],
      durationSamples: Option.some(
        estimatedLength(
          sourceStream.duration_ts,
          sourceStream.time_base,
          format.duration,
          sampleRate,
        ),
      ),
    };
  });

  const openAt = Effect.fn("Transcoder.openAt")(function* (input: TranscodeInput, startMs: number) {
    const admitted = yield* Effect.uninterruptible(
      Semaphore.takeIfAvailable(offsetRuns, 1).pipe(
        Effect.tap((taken) =>
          taken ? Effect.addFinalizer(() => Semaphore.release(offsetRuns, 1)) : Effect.void,
        ),
      ),
    );

    if (!admitted) return yield* new OffsetRunsBusy();

    const { sampleRate, aacRate, primingSamples, durationSamples } = yield* offsetTiming(
      input,
    ).pipe(Effect.mapError(failure(input)));

    const startSamples = Math.round((startMs * sampleRate) / 1000);

    const encoded = streamPiped(
      tools,
      offsetArgs(input.source, input.profile, startSamples / sampleRate, aacRate),
    );

    const bytes: Stream.Stream<Uint8Array, TranscodeError> = (
      isFragmentedProfile(input.profile)
        ? encoded.pipe(
            Stream.mapAccumEffect(
              () => timelineStart,
              (state, chunk) =>
                Effect.fromResult(shiftTimeline(BigInt(startSamples))(state, chunk)),
            ),
          )
        : encoded
    ).pipe(Stream.mapError(failure(input)));

    const [first, rest] = yield* Stream.peel(bytes, Sink.head());

    return {
      startSamples,
      primingSamples,
      sampleRate,
      durationSamples,
      bytes: Option.match(first, {
        onNone: () => Stream.empty,
        onSome: (chunk) => Stream.concat(Stream.make(chunk), rest),
      }),
    };
  });

  return Service.of({
    transcode: (input) =>
      open(input).pipe(
        Effect.flatMap(
          Opened.$match({
            Finished: ({ transcoded }) => Effect.succeed(transcoded),
            Live: ({ finished }) => finished,
          }),
        ),
        Effect.scoped,
      ),
    open,
    openAt,
    prepare,
  });
});

/** Music's transcoder over the server's tools, caching under `DATA_DIR`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | MediaTools.Service | FileSystem.FileSystem
> = Layer.effect(Service, make);
