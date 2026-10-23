/**
 * Transcodes tracks into a size-bounded cache under `MEDIA_DATA_DIR/cache`: fast-start AAC for
 * `<audio>`, and fragmented MP4 (FLAC or AAC) for the gapless MSE engine. A fragmented output has
 * a `.json` sidecar with its measured sample timing, written before the media file appears and
 * evicted with it.
 *
 * A transcode can be read while ffmpeg writes it: ffmpeg also writes a streamable copy (the
 * fragmented stream without its index, or ADTS for the AAC profiles) to a pipe the transcoder
 * copies into a "live" file beside the output, and readers follow that file as it grows.
 * Concurrent requests for the same output share one ffmpeg run, at most two ffmpeg runs happen at
 * once, a run that nobody waits for any more stops, and the least recently served files are
 * evicted when the cache grows past its limit.
 *
 * A seek ahead of a running transcode gets its own ffmpeg run from that point (`openAt`), which
 * streams straight to the one listener and is never cached.
 *
 * A download asks for the finished file without reading the live one (`prepare`): its transcode
 * runs detached from the request, in a lane of its own beside the shared runs.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { TrackId } from "@music/commands/ids";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
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
  runTool,
  runToolPiped,
  sourceProbeArgs,
  streamTool,
  timelineProbeArgs,
  transcodeArgs,
  type FragmentedProfile,
  type ProcessError,
  type TranscodeProfile,
} from "./ffmpeg.ts";
import * as Files from "./files.ts";
import { type FragmentTimelineError, shiftTimeline, timelineStart } from "./fragment-timeline.ts";
import { MediaConfig } from "./media-config.ts";
import { declaredLength, estimatedLength, measureTiming, SampleTiming } from "./sample-timing.ts";

const MAX_CONCURRENT_TRANSCODES = 2;

/**
 * Detached runs (`prepare`) encode in their own lane, beside the shared runs: a device downloading
 * a whole library never takes a listener's ffmpeg slot.
 */
const PREPARE_RUNS = 1;

/**
 * How long a detached run is held while nobody asks about it; then it stops like a stream nobody
 * reads. Well past a poller's `PREPARE_RETRY` and shorter than `TRANSCODE_TIMEOUT`, so a client
 * that gave up frees the prepare lane before the run would time out.
 */
export const PREPARE_HOLD = Duration.minutes(2);

/** How soon a client waiting for a detached run should ask again. */
const PREPARE_RETRY = Duration.seconds(2);

/** How long the failure of a detached run is reported; asking after that starts a new run. */
export const PREPARE_FAILURE_TTL = Duration.minutes(1);

/**
 * Offset runs (`openAt`) skip the cached transcodes' queue so a seek never waits behind other
 * songs; this caps them on their own. A player needs one at a time per playing device.
 */
export const MAX_CONCURRENT_OFFSET_RUNS = 8;

/** How long one ffmpeg run may take, from when it gets its slot (waiting for one is not counted). */
const TRANSCODE_TIMEOUT = Duration.minutes(10);

/**
 * How long a transcode keeps running after its last reader left. A listener who skips ahead frees
 * the ffmpeg slot for the next song; one who seeks in a live stream fetches it again at once and
 * finds the run still going.
 */
const ABANDON_GRACE = Duration.seconds(1);

const PROFILES: ReadonlyArray<TranscodeProfile> = ["aac-320", "aac-128", "fmp4-flac", "fmp4-aac"];

const SIDECAR_SUFFIX = ".json";

/** Temporary and live files end with this; eviction skips them and startup removes them. */
const PARTIAL_SUFFIX = ".part";

/** Largest piece a live reader reads from the live file at once. */
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
    | ProcessError
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
export class OffsetRunsBusy extends Data.TaggedError("OffsetRunsBusy")<{}> {
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
export interface FromOffset {
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
  /** True when ffmpeg runs. Cached for a minute. */
  readonly ffmpegAvailable: Effect.Effect<boolean>;
}

/** The transcode cache. */
export class Transcoder extends Context.Service<Transcoder, Interface>()(
  "@music/media/Transcoder",
) {}

/** Builds the `TranscodeError` for `input` from its cause. */
const failure = (input: TranscodeInput) => (cause: TranscodeError["cause"]) =>
  new TranscodeError({ trackId: input.trackId, profile: input.profile, cause });

/** How far one transcode has come; live readers follow it. */
type Progress = Data.TaggedEnum<{
  /** Waiting for a transcode slot, or probing the source. */
  Queued: {};
  /**
   * ffmpeg is running; the first `written` bytes of the live file are final. `timing` is the
   * expected timing of a fragmented profile.
   */
  Writing: { readonly timing: Option.Option<SampleTiming>; readonly written: number };
  /** The output is in the cache; the live file holds `written` bytes (0 without one). */
  Finished: { readonly transcoded: Transcoded; readonly written: number };
  Failed: { readonly error: TranscodeError };
}>;

const Progress = Data.taggedEnum<Progress>();

/** One running transcode. */
interface Job {
  readonly output: string;
  /** The slots its ffmpeg run takes one of: the shared ones, or the prepare lane. */
  readonly lane: Semaphore.Semaphore;
  /** Where the live copy goes. */
  readonly live: string;
  readonly progress: SubscriptionRef.SubscriptionRef<Progress>;
  /**
   * Readers holding the live file, and whether the job has settled. The live file is deleted
   * once both say it is no longer needed.
   */
  readonly holds: Ref.Ref<{ readonly readers: number; readonly settled: boolean }>;
  /** The fiber running ffmpeg, to stop it once nobody reads. */
  readonly fiber: Deferred.Deferred<Fiber.Fiber<void>>;
}

/** One read of a live file: the bytes, and where the next read starts (none at the end). */
type LivePage = readonly [ReadonlyArray<Uint8Array>, Option.Option<number>];

const writtenOf = (progress: Progress): number =>
  Progress.$match(progress, {
    Queued: () => 0,
    Writing: ({ written }) => written,
    Finished: ({ written }) => written,
    Failed: () => 0,
  });

/**
 * Waits until `select` passes on the job's progress (checked now and on every change), then runs
 * what it selected.
 */
const awaitProgress = <A, E>(
  job: Job,
  select: (progress: Progress) => Result.Result<Effect.Effect<A, E>, Progress>,
): Effect.Effect<A, E> =>
  SubscriptionRef.changes(job.progress).pipe(
    Stream.filterMap(select),
    Stream.runHead,
    // `changes` never ends, so the stream only stops once something was selected.
    Effect.flatMap(Option.getOrThrow),
  );

/**
 * Deletes the least recently used files until the cache fits in `maxBytes`. `lastUsed` holds the
 * serve times seen by this process; older files fall back to their modification time. Files are
 * never touched to record use, because their modification time feeds the `ETag` players send
 * back in `If-Range`. Entries of `lastUsed` for files no longer in the cache are dropped, so it
 * never outgrows the cache.
 */
const evict = Effect.fn("Transcoder.evict")(function* (
  cacheDir: string,
  maxBytes: number,
  keep: string,
  lastUsed: Map<string, number>,
) {
  const listed = yield* Effect.forEach(PROFILES, (profile) =>
    Files.listFiles(join(cacheDir, profile)),
  );

  // Sidecars go with their media file, so only media files are candidates.
  const files = listed
    .flat()
    .filter((file) => !file.path.endsWith(PARTIAL_SUFFIX) && !file.path.endsWith(SIDECAR_SUFFIX));

  const present = new Set(files.map((file) => file.path));

  for (const path of lastUsed.keys()) if (!present.has(path)) lastUsed.delete(path);

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
      lastUsed.delete(file.path);
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
  const scope = yield* Effect.scope;
  const cacheDir = join(config.dataDir, "cache");
  const permits = yield* Semaphore.make(MAX_CONCURRENT_TRANSCODES);
  const prepareLane = yield* Semaphore.make(PREPARE_RUNS);
  const offsetRuns = yield* Semaphore.make(MAX_CONCURRENT_OFFSET_RUNS);
  /** Serve times by cached file, updated in place: copying it on every serve would cost O(n). */
  const lastUsed = new Map<string, number>();
  /** Running jobs by output path. Changes, and holds taken on a job, happen under `registry`. */
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map());
  const registry = yield* Semaphore.make(1);
  /** Jobs held for `prepare` by output, with when someone last asked. Changed under `registry`. */
  const preparing = new Map<string, { readonly job: Job; readonly askedAt: number }>();
  /** Failures of held jobs by output, reported until `until`. Changed under `registry`. */
  const failures = new Map<string, { readonly error: TranscodeError; readonly until: number }>();

  const markUsed = (output: string, at: number): Effect.Effect<void> =>
    Effect.sync(() => {
      lastUsed.set(output, at);
    });

  const evictNow = (keep: string): Effect.Effect<void> =>
    evict(cacheDir, config.cacheMaxBytes, keep, lastUsed).pipe(
      Effect.catchTag("FileError", (error) => Effect.logWarning("Transcoder.evict_failed", error)),
    );

  yield* Effect.forEach(PROFILES, (profile) =>
    Effect.gen(function* () {
      const directory = join(cacheDir, profile);
      yield* Files.makeDirectory(directory);

      // Leftovers of runs that a crash or restart cut short.
      const partial = (yield* Files.listFiles(directory)).filter((file) =>
        file.path.endsWith(PARTIAL_SUFFIX),
      );

      yield* Effect.forEach(partial, (file) => Files.removePath(file.path));
    }),
  ).pipe(Effect.orDie);
  yield* evictNow("");

  /** Copies one piece of ffmpeg's live output into the live file and lets readers see it. */
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

  /** Creates the live file and lets readers follow it from now on. */
  const startLive = (job: Job, timing: Option.Option<SampleTiming>) =>
    Files.appendToFile(job.live, new Uint8Array()).pipe(
      Effect.andThen(SubscriptionRef.set(job.progress, Progress.Writing({ timing, written: 0 }))),
    );

  /**
   * Writes a fragmented transcode to `temporary` (and its live copy) and measures its timing.
   * Readers can follow the live copy from the moment the source probe gives its expected timing.
   */
  const encodeFragmented = Effect.fn("Transcoder.encodeFragmented")(function* (
    job: Job,
    input: TranscodeInput,
    profile: FragmentedProfile,
    temporary: string,
  ) {
    const sourceProbed = yield* runTool(config.ffprobePath, sourceProbeArgs(input.source));

    const {
      streams: [sourceStream],
      format,
    } = yield* decodeSourceProbe(sourceProbed.stdout);

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

    yield* runToolPiped(
      config.ffmpegPath,
      fragmentedArgs(input.source, temporary, profile, input.codec, aacRate),
      (chunk) => appendLive(job, chunk),
      (listing) => {
        decoded.push(listing);
      },
    );

    const probed = yield* runTool(config.ffprobePath, timelineProbeArgs(temporary));

    const {
      streams: [stream],
    } = yield* decodeTimelineProbe(probed.stdout);

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

    // Live readers already trimmed with the expected priming and rate. The finished file keeps
    // what was measured either way; a live reader that later sees different numbers gives up.
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

  /** Runs ffmpeg for `job` and moves the result into the cache. */
  const produce = Effect.fn("Transcoder.produce")(function* (job: Job, input: TranscodeInput) {
    const temporary = `${job.output}.${randomUUID()}${PARTIAL_SUFFIX}`;
    const profile = input.profile;

    const run = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      let timing: Option.Option<SampleTiming> = Option.none();

      if (isFragmentedProfile(profile)) {
        const measured = yield* encodeFragmented(job, input, profile, temporary);
        const json = yield* encodeSidecar(measured);

        // The sidecar lands first: a media file without one is never served as finished.
        yield* Files.writeFileAtomic(
          sidecarOf(job.output),
          new TextEncoder().encode(json),
          randomUUID(),
        );

        timing = Option.some(measured);
      } else {
        // Nothing to probe first: readers can follow the ADTS copy at once.
        yield* startLive(job, Option.none());
        yield* runToolPiped(
          config.ffmpegPath,
          transcodeArgs(input.source, temporary, profile),
          (chunk) => appendLive(job, chunk),
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
      // Inside the permit: a run that waited for a slot behind two long ones still gets its time.
      Effect.timeoutOrElse({
        duration: TRANSCODE_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
      Effect.onError(() => Files.removePath(temporary).pipe(Effect.ignore)),
      job.lane.withPermits(1),
    );

    const transcoded = yield* run;

    yield* markUsed(job.output, yield* Clock.currentTimeMillis);
    yield* evictNow(job.output);

    return transcoded;
  });

  const deleteLive = (job: Job): Effect.Effect<void> =>
    Files.removePath(job.live).pipe(Effect.ignore);

  /** Takes a job out of the registry, unless a newer job for its output took its place. */
  const unregister = (job: Job): Effect.Effect<void> =>
    Ref.update(jobs, (current) => {
      if (current.get(job.output) !== job) return current;
      const next = new Map(current);
      next.delete(job.output);

      return next;
    });

  /**
   * Retires a job once ffmpeg is done: new requests find the cached file (or start over after a
   * failure), readers learn the outcome, and the live file goes once no reader holds it.
   */
  const settle = (job: Job, input: TranscodeInput, exit: Exit.Exit<Transcoded, TranscodeError>) =>
    Effect.gen(function* () {
      yield* registry.withPermits(1)(unregister(job));

      // Settled before readers hear the outcome, so the last one to leave deletes the live file.
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

  /** Lets go of a job; the last reader of a settled job deletes its live file. */
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

  /**
   * Stops a running job that still has no readers: new requests start over, and ffmpeg is
   * killed, which frees its slot and lets `settle` clean up.
   */
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

  /** Holds a job, running and with its live file, until the scope closes. Call under `registry`. */
  const hold = (job: Job) =>
    Effect.acquireRelease(
      Ref.update(job.holds, (holds) => ({ ...holds, readers: holds.readers + 1 })),
      () => release(job),
    );

  /** Registers a new job on `lane` and starts it in the background. Call under `registry`. */
  const start = Effect.fn("Transcoder.start")(function* (
    input: TranscodeInput,
    output: string,
    lane: Semaphore.Semaphore,
  ) {
    const job: Job = {
      output,
      lane,
      live: `${output}.${randomUUID()}.live${PARTIAL_SUFFIX}`,
      progress: yield* SubscriptionRef.make<Progress>(Progress.Queued()),
      holds: yield* Ref.make({ readers: 0, settled: false }),
      fiber: yield* Deferred.make<Fiber.Fiber<void>>(),
    };

    yield* Ref.update(jobs, (current) => new Map(current).set(output, job));

    // The job belongs to the transcoder, not to a request: requests come and go as readers.
    const fiber = yield* produce(job, input).pipe(
      Effect.mapError(failure(input)),
      Effect.onExit((exit) => settle(job, input, exit)),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    yield* Deferred.succeed(job.fiber, fiber);

    return job;
  });

  /** The live file's bytes from `position` on, as far as they are written. */
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

  /** Every byte of the live file, following it until the job settles. */
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
      yield* markUsed(output, yield* Clock.currentTimeMillis);

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

  /** Waits until nobody has asked `prepare` about `job` for `PREPARE_HOLD`. */
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

  /** Forgets that `prepare` holds `job`, and remembers how it failed, if it did. */
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

  /**
   * Notes that someone asked `prepare` about `job` at `now`. The first ask holds the job until it
   * settles or `quietFor` passes, like a reader that stays. Call under `registry`.
   */
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

    if (Prepared.$is("Ready")(prepared)) yield* markUsed(output, now);

    return prepared;
  });

  /** The rates and expected length an offset transcode of `input` has. */
  const offsetTiming = Effect.fn("Transcoder.offsetTiming")(function* (input: TranscodeInput) {
    if (!isFragmentedProfile(input.profile)) {
      return {
        sampleRate: AAC_PROFILE_RATE,
        aacRate: AAC_PROFILE_RATE,
        primingSamples: AAC_PRIMING,
        durationSamples: Option.none<number>(),
      };
    }

    const probed = yield* runTool(config.ffprobePath, sourceProbeArgs(input.source));

    const {
      streams: [sourceStream],
      format,
    } = yield* decodeSourceProbe(probed.stdout);

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
    // One step: a client that leaves (which interrupts this) between taking the permit and
    // registering its release would otherwise lose the permit for good.
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

    // A whole sample, so the seek and the timeline agree exactly.
    const startSamples = Math.round((startMs * sampleRate) / 1000);

    const encoded = streamTool(
      config.ffmpegPath,
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

    // The first bytes come before the response, so a run that fails at once is an error status.
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

  const ffmpegAvailable = yield* Effect.cachedWithTTL(
    runTool(config.ffmpegPath, ["-hide_banner", "-version"]).pipe(
      Effect.as(true),
      Effect.catchTag("ProcessError", () => Effect.succeed(false)),
    ),
    Duration.minutes(1),
  );

  return Transcoder.of({
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
    ffmpegAvailable,
  });
});

/** The transcoder, configured by `MediaConfig`. */
export const layer: Layer.Layer<Transcoder, never, MediaConfig> = Layer.effect(Transcoder, make);
