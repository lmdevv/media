import {
  type ClientCapabilities,
  type DeliveredVideo,
  type InsufficientTranscodeSpace,
  type PlaybackQuality,
  type KeyframeIndexFailed,
  SegmentNotFound,
  SegmentNotReady,
  StreamAccessDenied,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
  TranscodeFailed,
  type TranscodeReason,
  type TranscodeSummary,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import type { PlaybackMode } from "@media/contracts/models/playback";
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  Schedule,
  MutableRef,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import type { MediaFileId, PlaybackSessionId, UserId } from "@media/contracts/ids";
import { StreamId } from "@media/contracts/media-playback";
import { LogEvent } from "../diagnostics/log-events.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { watchRenames } from "../platform/node-directories.ts";
import type { ResolvedMediaFile } from "./file-resolver.ts";
import {
  FRAGMENT_HEAD_BYTES,
  fragmentHeadLength,
  fragmentSpan,
  type VideoTiming,
  videoTiming,
} from "./fmp4-fragments.ts";
import {
  groupFragments,
  planGridSegments,
  planKeyframeSegments,
  reachOf,
  type SegmentPlan,
  segmentAt,
} from "./hls-plan.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import * as EncoderSlots from "./encoder-slots.ts";
import { AudioPlan, modeOf, type PlaybackPlan, replan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import type { PlaybackGrant } from "./playback-grants.ts";
import * as SessionReports from "./session-reports.ts";
import * as StreamLiveness from "./stream-liveness.ts";
import * as StreamOwners from "./stream-owners.ts";
import * as TranscodeSpace from "./transcode-space.ts";
import { sourceScope, type SourceScope } from "./capability-inventory.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import { hlsCommand } from "./transcode-command.ts";
import { deliveredVideo, reasonOf, summaryOf } from "./transcode-diagnostics.ts";
import {
  advance,
  Diagnosis,
  fresh as recovered,
  type LogOwners,
  Recovery,
  type RecoveryState,
} from "./transcode-recovery.ts";
import {
  samePipeline,
  sourceOf,
  stillVerified,
  usesGpu,
  type VideoIntent,
} from "./video-pipeline.ts";
import type { ImplId } from "./video-ops.ts";

interface StartRequest {
  readonly file: ResolvedMediaFile;
  readonly plan: Extract<PlaybackPlan, { readonly _tag: "Hls" }>;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly startSeconds: number;
  readonly quality: PlaybackQuality | undefined;
  readonly burnSubtitle: number | undefined;
  readonly keyframes: ReadonlyArray<number> | undefined;
}

interface StartedStream {
  readonly streamId: StreamId;
  /** The generation that actually started, after any replacement at startup. */
  readonly generation: number;
  readonly mode: Exclude<PlaybackMode, "direct">;
  /** What that generation does with the video, which may differ from the plan asked for. */
  readonly video: VideoPlan;
  /** Where that generation's video is made, and the changes that led there. */
  readonly transcode: TranscodeSummary;
  readonly segmentIndex: number;
}

interface StreamView {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly plan: SegmentPlan;
}

/** Where a seek continues, and how that generation delivers the video. */
interface MovedStream extends StreamView {
  readonly mode: Exclude<PlaybackMode, "direct">;
  readonly video: DeliveredVideo;
  readonly transcode: TranscodeSummary;
}

interface ServedPart {
  readonly file: FileSystem.File;
  readonly sizeBytes: number;
}

interface ServedSegment {
  readonly parts: ReadonlyArray<ServedPart>;
  readonly sizeBytes: number;
}

type StreamRequestError =
  | StreamNotFound
  | StreamAccessDenied
  | StreamGenerationGone
  | SegmentNotFound
  | SegmentNotReady
  | TranscodeFailed
  | UnsupportedPlayback;

/** Failures of starting a stream. `StreamNotFound`: a newer negotiation replaced it meanwhile. */
export type StartError =
  | StreamNotFound
  | TranscodeCapacityReached
  | InsufficientTranscodeSpace
  | UnsupportedPlayback
  | TranscodeFailed
  | KeyframeIndexFailed;

interface Negotiation {
  /**
   * Starts the HLS stream the negotiation chose, replacing the session's streams.
   * `StreamNotFound` when a newer negotiation of the session began meanwhile.
   */
  readonly start: (request: StartRequest) => Effect.Effect<StartedStream, StartError>;
  /**
   * Closes the session's streams for direct play. False, changing nothing, when a newer
   * negotiation of the session began meanwhile.
   */
  readonly direct: Effect.Effect<boolean>;
}

/** HLS stream sessions. */
export interface Interface {
  /**
   * Begins negotiating the streams of `grant`'s session, for the scope. Only the negotiation begun
   * last can change them, so overlapping negotiations, a retry after a timeout for example, leave
   * the newest one's choice whichever mode each picks, and no stream an older one started.
   */
  readonly negotiate: (grant: PlaybackGrant) => Effect.Effect<Negotiation, never, Scope.Scope>;
  readonly playlist: (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<StreamView, StreamRequestError>;
  readonly init: (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<Uint8Array, StreamRequestError>;
  /**
   * Opens the files of segment `index` for the scope; the stream keeps their folder until the
   * scope closes.
   */
  readonly segment: (
    streamId: StreamId,
    generation: number,
    index: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<ServedSegment, StreamRequestError, Scope.Scope>;
  /**
   * Moves playback to `seconds`, starting a new generation unless that point is already produced,
   * and answers how the generation that covers it delivers the video.
   */
  readonly seek: (
    streamId: StreamId,
    seconds: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<MovedStream, StreamRequestError>;
  readonly stop: (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) => Effect.Effect<void, StreamNotFound | StreamAccessDenied>;
  /** Number of streams whose encoder runs; a released stream waiting for its player is not one. */
  readonly activeCount: Effect.Effect<number>;
  /** Runs whose ffmpeg has not exited yet, closed streams' included, such as a stuck one's. */
  readonly runsAwaitingExit: Effect.Effect<number>;
}

/** The stream session manager. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/StreamSessions",
) {}

const LOOKAHEAD_SEGMENTS = 3;

const THROTTLE_INTERVAL = Duration.seconds(1);

/** How often a wait for a segment reads its folder when no fragment write woke it sooner. */
export const PollInterval = Context.Reference<Duration.Duration>(
  "@media/server/StreamSessions/PollInterval",
  { defaultValue: () => Duration.millis(50) },
);

const SEGMENT_WAIT = Duration.seconds(30);

const START_WAIT = Duration.seconds(20);

/**
 * Effect's Node process release sends `SIGKILL`, again after `forceKillAfter`, then waits for the
 * exit without a bound, as for ffmpeg stuck in disk I/O.
 */
const STOP_WAIT = Duration.seconds(3);

const KEEP_INIT_WAIT = Duration.seconds(2);

const READY_WAIT = Duration.times(Duration.sum(KEEP_INIT_WAIT, STOP_WAIT), 2);

/** How long the capability service may take to diagnose a failed run. */
const DIAGNOSIS_WAIT = Duration.seconds(5);

/**
 * A start covers its first run and both replacements recovery may start, each after a diagnosis.
 */
const FIRST_RUN_WAIT = Duration.sum(
  Duration.times(Duration.sum(READY_WAIT, START_WAIT), 3),
  Duration.sum(STOP_WAIT, Duration.times(DIAGNOSIS_WAIT, 2)),
);

const FRAGMENT_FILE = /^f\d+\.m4s$/;

class FragmentWatchFailed extends Data.TaggedError("FragmentWatchFailed")<{
  readonly cause: unknown;
}> {}

/**
 * When a segment counts as produced: `written` once its last fragment is, and `followed` once the
 * encoder has also started the next one. The first segment of a run with a stage on a GPU, and so
 * its init, waits for `followed`, which shows the device got past its first fragment before any of
 * its bytes reach the player.
 */
type Readiness = "written" | "followed";

interface Fragment {
  readonly path: string;
  readonly start: number;
  readonly end: number | undefined;
  readonly sizeBytes: number;
}

interface Generation {
  readonly number: number;
  readonly streamId: StreamId;
  /** Whether the run has a stage on a GPU, which a failure replaces before its bytes are served. */
  readonly onGpu: boolean;
  /** What the run does with the video. */
  readonly video: VideoPlan;
  /** Which of the run's steps own the names in ffmpeg's log; none for a copy. */
  readonly owners: LogOwners | undefined;
  /** Set once recovery gave up on this generation: every request of it answers this. */
  readonly failed: MutableRef.MutableRef<Option.Option<TranscodeFailed>>;
  readonly startSegment: number;
  readonly from: number;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly readers: Scope.Closeable;
  readonly files: Scope.Closeable;
  readonly exit: Deferred.Deferred<void, MediaTools.MediaToolFailed>;
  readonly fragments: Ref.Ref<ReadonlyArray<Fragment>>;
  readonly refreshLock: Semaphore.Semaphore;
  readonly wake: MutableRef.MutableRef<Deferred.Deferred<void>>;
  /** The read of the run's new fragments in progress, with the fragment wake it began under. */
  readonly refreshing: MutableRef.MutableRef<Option.Option<Refresh>>;
  readonly endUnknownLogged: MutableRef.MutableRef<boolean>;
  /** The video timing read from the run's `init.mp4`, once its first fragment is written. */
  readonly videoTiming: MutableRef.MutableRef<Option.Option<VideoTiming>>;
  readonly suspend: (paused: boolean) => Effect.Effect<void>;
  readonly paused: Ref.Ref<boolean>;
}

interface Refresh {
  readonly seen: Deferred.Deferred<void>;
  readonly reading: Fiber.Fiber<boolean>;
}

interface RunScope {
  readonly scope: Scope.Closeable;
  readonly readers: Scope.Closeable;
  readonly files: Scope.Closeable;
  readonly stopping: MutableRef.MutableRef<boolean>;
  /** Once its process exited, which frees its slot. */
  readonly exited: Deferred.Deferred<void>;
  /** Once its folder is gone too, after its reads and the responses that hold its files. */
  readonly stopped: Deferred.Deferred<void>;
}

interface Run extends RunScope {
  readonly held: EncoderSlots.Held;
}

interface Runs {
  readonly live: ReadonlyMap<Scope.Closeable, RunScope>;
  readonly sealed: boolean;
}

/** A generation's init segment kept while its stream is released, and the reads of it. */
interface KeptInit {
  readonly generation: number;
  readonly file: string;
  readonly readers: Scope.Closeable;
  readonly draining: MutableRef.MutableRef<boolean>;
  /** Once no read of the file is open and none can start. */
  readonly drained: Deferred.Deferred<void>;
}

interface Lifecycle {
  readonly streamId: StreamId;
  readonly scope: Scope.Closeable;
  readonly runs: Ref.Ref<Runs>;
  readonly keptInits: Ref.Ref<ReadonlyMap<number, KeptInit>>;
  /** Runs of every stream, closed ones included, whose process has not exited. */
  readonly serverRunsAwaitingExit: Ref.Ref<number>;
  readonly directory: string;
  readonly torndown: Deferred.Deferred<void>;
}

type Encoder = Data.TaggedEnum<{
  Running: { readonly run: Run };
  Released: { readonly since: number; readonly keptInit: Option.Option<KeptInit> };
}>;

const Encoder = Data.taggedEnum<Encoder>();

type InitSource = Data.TaggedEnum<{
  Kept: { readonly kept: KeptInit };
  Run: { readonly run: Generation };
}>;

const InitSource = Data.taggedEnum<InitSource>();

/** A stream's use, and whether it still admits requests; no request gets in once a close began. */
interface Admission extends StreamLiveness.Use {
  readonly admitting: boolean;
}

/** A lifecycle step of a stream; `callerGone` completes once its caller stops waiting for it. */
type Step<A, E> = (callerGone: Effect.Effect<void>) => Effect.Effect<A, E>;

/** Reads a stream's state now and judges its use against it, for a close that must still hold. */
type Condition = Effect.Effect<(use: StreamLiveness.Use) => boolean>;

interface Session extends Lifecycle {
  readonly sessionId: PlaybackSessionId;
  /** The ticket of the negotiation that started it. */
  readonly ticket: number;
  readonly audience: EncoderSlots.Audience;
  readonly userId: UserId;
  readonly fileId: MediaFileId;
  readonly file: ResolvedMediaFile;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly quality: PlaybackQuality | undefined;
  readonly burnSubtitle: number | undefined;
  readonly plan: SegmentPlan;
  /** What new runs do with the video; a replacement after a failure changes it. */
  readonly video: Ref.Ref<VideoPlan>;
  readonly audio: AudioPlan;
  /** The file version and video stream the capability service keeps its evidence under. */
  readonly evidence: SourceScope;
  /** Failures since a run last served a segment, and the rows this stream keeps off. */
  readonly recovery: Ref.Ref<RecoveryState>;
  /** How the transcode changed after failures, oldest first. */
  readonly changes: Ref.Ref<ReadonlyArray<PipelineChange>>;
  /**
   * Segments where recovery gave up, and what their requests answer: no run starts there again
   * until a later run serves one, which clears it.
   */
  readonly ended: Ref.Ref<ReadonlyMap<number, TranscodeFailed>>;

  readonly generation: Ref.Ref<Generation>;
  readonly lane: Semaphore.Semaphore;
  readonly encoder: Ref.Ref<Encoder>;
  readonly use: Ref.Ref<Admission>;
  readonly liveness: Ref.Ref<StreamLiveness.Liveness>;
  readonly requested: Ref.Ref<number>;
  readonly served: Ref.Ref<boolean>;
  readonly runFolders: Ref.Ref<number>;
}

interface Produced {
  readonly members: ReadonlyMap<number, ReadonlyArray<Fragment>>;
  readonly head: number;
}

/**
 * A change to a stream's transcode: after a failure, the diagnosis and the rows it kept the
 * stream off; or a capability its chain used was lost before a new run.
 */
interface PipelineChange {
  readonly at: number;
  readonly generation: number;
  readonly cause: Diagnosis["_tag"] | "capability-lost";
  readonly excluded: ReadonlyArray<ImplId>;
  readonly reason: TranscodeReason;
}

const isEncode = VideoPlan.$is("Encode");

/** Whether `video` runs any stage on a GPU. */
const onGpu = (video: VideoPlan): boolean => isEncode(video) && usesGpu(video.pipeline);

/**
 * Ends recovery at segment `index`: requests of `generation` answer `failure` from now on, and the
 * session remembers the position, so an idle release and a revive start no run there again, while
 * a seek elsewhere starts afresh; a later run that serves the position makes it forget it.
 */
const giveUp = (
  session: Session,
  generation: Generation,
  index: number,
  failure: TranscodeFailed,
) =>
  Effect.sync(() => MutableRef.set(generation.failed, Option.some(failure))).pipe(
    Effect.andThen(Ref.update(session.ended, (known) => new Map(known).set(index, failure))),
    Effect.andThen(Effect.fail(failure)),
  );

/** Fails with what segment `index` answers when recovery gave up there. */
const unlessEnded = (session: Session, index: number) =>
  Ref.get(session.ended).pipe(
    Effect.flatMap((known) => {
      const failure = known.get(index);

      return failure === undefined ? Effect.void : Effect.fail(failure);
    }),
  );

/** What a diagnosis found, as a change's cause. */
const causeOf = (diagnosis: Diagnosis): Diagnosis["_tag"] =>
  Diagnosis.$match(diagnosis, {
    Capability: () => "Capability" as const,
    Source: () => "Source" as const,
    Undecided: () => "Undecided" as const,
    NotVideo: () => "NotVideo" as const,
    Unexplained: () => "Unexplained" as const,
  });

/** The first line of a failed run's log, its paths replaced, for the service's own log. */
const firstLine = (failure: MediaTools.MediaToolFailed): string =>
  (
    failure.stderrHead
      .trim()
      .split("\n")
      .find((line) => !line.startsWith("libva info:")) ?? ""
  ).slice(0, 300);

const noSegment = (): number => -1;

const isClosed = (scope: Scope.Scope): boolean => Predicate.isTagged(scope.state, "Closed");

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);

  return next;
};

const beginStop = (stream: Lifecycle, run: RunScope) =>
  Effect.suspend(() =>
    MutableRef.getAndSet(run.stopping, true)
      ? Effect.void
      : Effect.all(
          [
            Scope.close(run.scope, Exit.void).pipe(
              Effect.ensuring(
                Ref.update(stream.serverRunsAwaitingExit, (count) => count - 1).pipe(
                  Effect.andThen(Deferred.succeed(run.exited, undefined)),
                ),
              ),
            ),
            Scope.close(run.readers, Exit.void),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.andThen(Scope.close(run.files, Exit.void)),
          Effect.ensuring(
            Ref.update(stream.runs, (runs) => ({
              ...runs,
              live: without(runs.live, run.scope),
            })).pipe(Effect.andThen(Deferred.succeed(run.stopped, undefined))),
          ),
          Effect.forkDetach,
          Effect.asVoid,
        ),
  ).pipe(Effect.uninterruptible);

const whileOpen = <A, E, R>(scope: Scope.Scope, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const running = MutableRef.make(false);
    const done = yield* Deferred.make<void>();

    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => (MutableRef.get(running) ? Deferred.await(done) : Effect.void)),
    );

    const open = yield* Effect.sync(() => {
      if (isClosed(scope)) return false;
      MutableRef.set(running, true);

      return true;
    });

    if (!open) return Option.none<A>();

    return Option.some(yield* effect.pipe(Effect.ensuring(Deferred.succeed(done, undefined))));
  });

const finishOnceStarted = <A, E>(read: Effect.Effect<A, E>) =>
  Effect.uninterruptibleMask((restore) => restore(Effect.void).pipe(Effect.andThen(read)));

const forkReader = <A, E>(generation: Generation, read: Effect.Effect<A, E>) =>
  finishOnceStarted(read).pipe(Effect.forkIn(generation.readers));

const awaitReader = <A, E>(reading: Fiber.Fiber<A, E>) =>
  Fiber.await(reading).pipe(
    Effect.flatMap((exit): Effect.Effect<Option.Option<A>, E> =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.succeedNone
        : Effect.asSome(exit),
    ),
  );

const readerOf = <A, E>(generation: Generation, read: Effect.Effect<A, E>) =>
  forkReader(generation, read).pipe(Effect.flatMap(awaitReader));

const stopWaitingAfter =
  <L>(wait: Duration.Duration, late: () => L) =>
  <A, E, R>(request: Effect.Effect<A, E, R>) =>
    request.pipe(Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(late()) }));

const endOfStart = (
  cause: Cause.Cause<StartError>,
  lostSlot: boolean,
): PlaybackReporter.StreamEndReason =>
  Cause.hasInterrupts(cause) ? "abandoned" : lostSlot ? "capacity-reached" : "failed";

const drain = (kept: KeptInit) =>
  Effect.suspend(() =>
    MutableRef.getAndSet(kept.draining, true)
      ? Deferred.await(kept.drained)
      : Scope.close(kept.readers, Exit.void).pipe(
          Effect.ensuring(Deferred.succeed(kept.drained, undefined)),
        ),
  );

const awaitExited = (run: RunScope) =>
  Effect.interruptible(
    Deferred.await(run.exited).pipe(Effect.timeoutOption(STOP_WAIT), Effect.asVoid),
  );

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tools = yield* MediaTools.Service;
  const keyframes = yield* KeyframeIndex.Service;
  const capabilities = yield* TranscodeCapabilities.Service;
  const reporter = yield* PlaybackReporter.Service;
  const space = yield* TranscodeSpace.Service;
  const owners = yield* StreamOwners.Service;
  const reports = yield* SessionReports.Service;
  const sessions = yield* Ref.make<ReadonlyMap<StreamId, Session>>(new Map());
  const awaitingExit = yield* Ref.make(0);
  const transcodes = yield* EncoderSlots.make(config.maxConcurrentTranscodes);
  const copies = yield* EncoderSlots.make(config.maxConcurrentRemuxes);
  const registry = yield* Semaphore.make(1);

  /**
   * Negotiations get increasing tickets. Per session: the ticket of the one begun last, until it
   * ends; an older one still open then finds none, which is not its own.
   */
  const negotiations = yield* Ref.make<{
    readonly issued: number;
    readonly latest: ReadonlyMap<PlaybackSessionId, number>;
  }>({ issued: 0, latest: new Map() });

  const services = yield* Effect.context();
  const pollInterval = yield* PollInterval;

  yield* fs.makeDirectory(config.transcodeDir, { recursive: true }).pipe(Effect.orDie);

  for (const name of yield* fs
    .readDirectory(config.transcodeDir)
    .pipe(Effect.orElseSucceed(() => []))) {
    yield* fs.remove(path.join(config.transcodeDir, name), { recursive: true }).pipe(Effect.ignore);
  }

  const newStreamId = crypto.randomBytes(16).pipe(
    Effect.map((bytes) => StreamId.make(Buffer.from(bytes).toString("base64url"))),
    Effect.orDie,
  );

  const idleMillis = Duration.toMillis(config.streamIdleTimeout);

  const startWait = Duration.sum(
    Duration.sum(START_WAIT, config.fileScanTimeout),
    Duration.sum(STOP_WAIT, FIRST_RUN_WAIT),
  );

  const keptInitOf = (session: Session, generation: number) =>
    path.join(session.directory, `init-${generation}.mp4`);

  const snapshotOf = Effect.fnUntraced(function* (session: Session) {
    return StreamLiveness.snapshot(
      yield* Ref.get(session.use),
      yield* Ref.get(session.liveness),
      yield* Clock.currentTimeMillis,
      idleMillis,
    );
  });

  const reportEnded = Effect.fnUntraced(function* (
    session: Session,
    reason: PlaybackReporter.StreamEndReason,
  ) {
    const moment = yield* snapshotOf(session);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.StreamEnded.make({
        sessionId: session.sessionId,
        userId: session.userId,
        fileId: session.fileId,
        streamId: session.streamId,
        reason,
        liveness: moment.liveness,
        inFlight: moment.inFlight,
        lastRequestAgeMs: moment.lastRequestAgeMs,
        lastProgressAgeMs: moment.lastProgressAgeMs,
      }),
    );
  });

  /** Stops admitting requests if `holds` on the current use, in that same update; whether it did. */
  const stopAdmitting = (session: Session, holds: (use: StreamLiveness.Use) => boolean) =>
    Ref.modify(session.use, (use) =>
      use.admitting && holds(use)
        ? ([true, { ...use, admitting: false }] as const)
        : ([false, use] as const),
    );

  const openRun = Effect.fnUntraced(function* (stream: Lifecycle) {
    const run: RunScope = {
      scope: yield* Scope.make("sequential"),
      readers: yield* Scope.make(),
      files: yield* Scope.make(),
      stopping: MutableRef.make(false),
      exited: yield* Deferred.make<void>(),
      stopped: yield* Deferred.make<void>(),
    };

    const opened = yield* Ref.modify(stream.runs, (runs) =>
      runs.sealed
        ? ([false, runs] as const)
        : ([true, { ...runs, live: new Map(runs.live).set(run.scope, run) }] as const),
    ).pipe(
      Effect.tap((added) =>
        added ? Ref.update(stream.serverRunsAwaitingExit, (count) => count + 1) : Effect.void,
      ),
      Effect.uninterruptible,
    );

    if (!opened) return yield* new StreamNotFound({ streamId: stream.streamId });

    return run;
  });

  const teardown = (stream: Lifecycle) =>
    Ref.modify(stream.runs, (runs) =>
      runs.sealed ? ([false, runs] as const) : ([true, { ...runs, sealed: true }] as const),
    ).pipe(
      Effect.flatMap((first) =>
        first
          ? Effect.gen(function* () {
              const fibers = yield* Scope.close(stream.scope, Exit.void).pipe(Effect.forkDetach);
              const live = [...(yield* Ref.get(stream.runs)).live.values()];

              yield* Effect.forEach(live, (run) => beginStop(stream, run), { discard: true });
              yield* Fiber.await(fibers);
              yield* Effect.forEach(live, (run) => Deferred.await(run.stopped), { discard: true });
              yield* Effect.forEach((yield* Ref.get(stream.keptInits)).values(), drain, {
                concurrency: "unbounded",
                discard: true,
              });
              yield* fs.remove(stream.directory, { recursive: true }).pipe(Effect.ignore);
            }).pipe(
              Effect.ensuring(Deferred.succeed(stream.torndown, undefined)),
              Effect.forkDetach,
            )
          : Effect.void,
      ),
      Effect.uninterruptible,
      Effect.andThen(
        Effect.interruptible(
          Deferred.await(stream.torndown).pipe(Effect.timeoutOption(STOP_WAIT), Effect.asVoid),
        ),
      ),
    );

  const onStreamFiber = <A, E>(session: Session, step: Step<A, E>) =>
    Effect.gen(function* () {
      const gone = yield* Deferred.make<void>();
      const fiber = yield* step(Deferred.await(gone)).pipe(Effect.forkIn(session.scope));

      const exit = yield* Fiber.await(fiber).pipe(
        Effect.onInterrupt(() => Deferred.succeed(gone, undefined)),
      );

      return yield* Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.fail(new StreamNotFound({ streamId: session.streamId }))
        : exit;
    });

  const transition = <A, E>(session: Session, step: Step<A, E>) =>
    onStreamFiber(session, (callerGone) => session.lane.withPermits(1)(step(callerGone)));

  const transitionIfIdle = <A, E>(session: Session, step: Step<A, E>) =>
    onStreamFiber(session, (callerGone) =>
      session.lane.withPermitsIfAvailable(1)(step(callerGone)),
    );

  /**
   * Closes `session` unless `condition` fails on its use when the close begins, so a request
   * admitted before that keeps the stream and one arriving after finds it gone.
   */
  const closeSession = Effect.fn("StreamSessions.close")(function* (
    session: Session,
    reason: PlaybackReporter.StreamEndReason,
    condition: Condition = Effect.succeed(() => true),
  ) {
    if (!(yield* stopAdmitting(session, yield* condition))) return;

    const removed = yield* Ref.modify(sessions, (current) => {
      if (current.get(session.streamId) !== session) return [false, current] as const;
      const next = new Map(current);
      next.delete(session.streamId);

      return [true, next] as const;
    });

    yield* teardown(session).pipe(
      Effect.ensuring(
        removed
          ? owners.closed(session.streamId).pipe(Effect.andThen(reportEnded(session, reason)))
          : Effect.void,
      ),
    );
  }, Effect.uninterruptible);

  const videoTimingOf = Effect.fnUntraced(function* (generation: Generation) {
    const known = MutableRef.get(generation.videoTiming);

    if (Option.isSome(known)) return known;

    const read = yield* fs.readFile(path.join(generation.directory, "init.mp4")).pipe(
      Effect.map((init) => Option.fromNullishOr(videoTiming(init))),
      Effect.orElseSucceed(() => Option.none<VideoTiming>()),
    );

    if (Option.isNone(read)) {
      yield* Effect.logDebug("StreamSessions.init_timing_unreadable").pipe(
        Effect.annotateLogs({ streamId: generation.streamId, generation: generation.number }),
      );
    }

    MutableRef.set(generation.videoTiming, read);

    return read;
  });

  const refreshFragments = Effect.fnUntraced(
    function* (generation: Generation) {
      const known = new Set(
        (yield* Ref.get(generation.fragments)).map((fragment) => fragment.path),
      );

      const names = yield* fs
        .readDirectory(generation.directory)
        .pipe(Effect.orElseSucceed(() => []));

      const files = names
        .filter((name) => FRAGMENT_FILE.test(name))
        .map((name) => path.join(generation.directory, name))
        .filter((file) => !known.has(file));

      const timing = files.length === 0 ? Option.none() : yield* videoTimingOf(generation);

      const fresh = yield* Effect.forEach(files, (file) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(file);
            const info = yield* handle.stat;

            const head = Option.getOrElse(
              yield* handle.readAlloc(FRAGMENT_HEAD_BYTES, { position: 0n }),
              () => new Uint8Array(0),
            );

            const length = Math.min(fragmentHeadLength(head) ?? 0, Number(info.size));

            const rest =
              length <= head.byteLength
                ? new Uint8Array(0)
                : Option.getOrElse(
                    yield* handle.readAlloc(length - head.byteLength, {
                      position: BigInt(head.byteLength),
                    }),
                    () => new Uint8Array(0),
                  );

            const bytes = new Uint8Array(head.byteLength + rest.byteLength);

            bytes.set(head);
            bytes.set(rest, head.byteLength);

            const span = Option.flatMap(timing, (video) =>
              Option.fromNullishOr(fragmentSpan(video, bytes)),
            );

            if (
              Option.isSome(span) &&
              span.value.end === undefined &&
              !MutableRef.getAndSet(generation.endUnknownLogged, true)
            ) {
              yield* Effect.logWarning("StreamSessions.fragment_end_unknown").pipe(
                Effect.annotateLogs({
                  streamId: generation.streamId,
                  generation: generation.number,
                  fragment: file,
                }),
              );
            }

            return Option.map(span, ({ start, end }): Fragment => ({
              path: file,
              start,
              end,
              sizeBytes: Number(info.size),
            }));
          }),
        ).pipe(Effect.orElseSucceed(() => Option.none<Fragment>())),
      );

      const added = fresh.flatMap((fragment) => (Option.isSome(fragment) ? [fragment.value] : []));

      if (added.length > 0) {
        yield* Ref.update(generation.fragments, (current) =>
          [...current, ...added].toSorted((left, right) => left.start - right.start),
        );
      }

      return added.length === fresh.length;
    },
    (refresh, generation) => generation.refreshLock.withPermits(1)(refresh),
  );

  const parsedNewFragments = (generation: Generation) =>
    Effect.suspend(() => {
      const seen = MutableRef.get(generation.wake);
      const current = MutableRef.get(generation.refreshing);

      if (
        Option.isSome(current) &&
        current.value.seen === seen &&
        current.value.reading.pollUnsafe() === undefined
      ) {
        return awaitReader(current.value.reading);
      }

      return forkReader(generation, refreshFragments(generation)).pipe(
        Effect.tap((reading) =>
          Effect.sync(() => MutableRef.set(generation.refreshing, Option.some({ seen, reading }))),
        ),
        Effect.flatMap(awaitReader),
      );
    }).pipe(Effect.map((parsed) => Option.getOrElse(parsed, () => false)));

  const producedRange = (
    session: Session,
    generation: Generation,
    fragments: ReadonlyArray<Fragment>,
  ): Produced => {
    const members = groupFragments(
      session.plan,
      generation.startSegment,
      generation.from,
      fragments,
    );

    return { members, head: Math.max(generation.startSegment, ...members.keys()) };
  };

  const startGeneration = Effect.fn("StreamSessions.startGeneration")(function* (
    session: Session,
    run: Run,
    previous: Option.Option<RunScope>,
    number: number,
    startSegment: number,
  ) {
    const folder = yield* Ref.updateAndGet(session.runFolders, (made) => made + 1);
    const directory = path.join(session.directory, String(folder));
    const scope = run.scope;

    yield* Scope.addFinalizer(
      run.files,
      fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);

    const video = session.file.probe.video;
    const from = session.plan.starts[startSegment] ?? session.plan.end;
    const videoPlan = yield* Ref.get(session.video);

    const command = hlsCommand({
      input: session.file.path,
      sourceStart: session.file.probe.startSeconds,
      from,
      videoIndex: video?.index ?? 0,
      videoCodec: video?.codec ?? "",
      video: videoPlan,
      audio: session.audio,
      audioCodec: AudioPlan.$match(session.audio, {
        None: () => "",
        Aac: () => "",
        Copy: ({ index }) =>
          session.file.probe.audio.find((track) => track.index === index)?.codec ?? "",
      }),
      copiedAudioEnd: AudioPlan.$match(session.audio, {
        None: () => undefined,
        Aac: () => undefined,
        Copy: ({ index }) =>
          session.file.probe.audio.find((track) => track.index === index)?.endSeconds,
      }),
      segmentStarts: session.plan.starts.slice(startSegment),
      previousStart: session.plan.starts[startSegment - 1],
      outputDirectory: directory,
    });

    const exit = yield* Deferred.make<void, MediaTools.MediaToolFailed>();
    const wake = MutableRef.make(Deferred.makeUnsafe<void>());

    const wakeWaits = () => {
      Deferred.doneUnsafe(MutableRef.getAndSet(wake, Deferred.makeUnsafe<void>()), Effect.void);
    };

    const watchFailed = (cause: unknown) =>
      Effect.logWarning("StreamSessions.fragment_watch_failed", cause).pipe(
        Effect.annotateLogs({ streamId: session.streamId, generation: number }),
      );

    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          watchRenames(
            directory,
            (name) => FRAGMENT_FILE.test(name),
            wakeWaits,
            (cause) => {
              Effect.runForkWith(services)(watchFailed(cause));
            },
          ),
        catch: (cause) => new FragmentWatchFailed({ cause }),
      }),
      (stop) => Effect.sync(stop),
    ).pipe(
      Effect.catch((error) => watchFailed(error.cause)),
      Scope.provide(scope),
    );

    const suspender = MutableRef.make<(paused: boolean) => Effect.Effect<void>>(() => Effect.void);

    const generation: Generation = {
      number,
      streamId: session.streamId,
      onGpu: onGpu(videoPlan),
      video: videoPlan,
      owners: command.owners,
      failed: MutableRef.make(Option.none<TranscodeFailed>()),
      startSegment,
      from,
      directory,
      scope,
      readers: run.readers,
      files: run.files,
      exit,
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      wake,
      refreshing: MutableRef.make(Option.none<Refresh>()),
      endUnknownLogged: MutableRef.make(false),
      videoTiming: MutableRef.make(Option.none<VideoTiming>()),
      suspend: (paused) => Effect.suspend(() => MutableRef.get(suspender)(paused)),
      paused: yield* Ref.make(false),
    };

    yield* Ref.set(session.requested, startSegment);
    const replaced = yield* Ref.getAndSet(session.generation, generation);

    if (number > 1 && replaced.number !== number) {
      yield* retireKeptInit(session, replaced.number);
      yield* Effect.logInfo(LogEvent.streamMoved).pipe(
        Effect.annotateLogs({
          sessionId: session.sessionId,
          userId: session.userId,
          streamId: session.streamId,
          generation: number,
          segment: startSegment,
          fromSeconds: from,
        }),
      );
    }

    if (Option.isSome(previous)) yield* beginStop(session, previous.value);

    const awaitPrevious = Option.match(previous, {
      onNone: () => Effect.void,
      onSome: awaitExited,
    });

    const ready = yield* run.held.ready.pipe(Effect.timeoutOption(READY_WAIT));

    if (Option.isNone(ready)) {
      yield* Effect.logWarning("StreamSessions.encoder_wait_timed_out").pipe(
        Effect.annotateLogs({
          sessionId: session.sessionId,
          streamId: session.streamId,
          generation: number,
        }),
      );
    }

    if (Option.isNone(ready) || (yield* run.held.isLost)) {
      yield* awaitPrevious;

      return Option.none<Generation>();
    }

    const spawned = yield* whileOpen(
      scope,
      tools.startFfmpeg(command.args).pipe(
        Scope.provide(scope),
        Effect.catch((error) => Deferred.fail(exit, error).pipe(Effect.as(undefined))),
      ),
    );

    if (Option.isNone(spawned)) {
      yield* awaitPrevious;

      return Option.none<Generation>();
    }

    const running = spawned.value;

    yield* Scope.addFinalizer(scope, Effect.sync(wakeWaits));

    if (running !== undefined) {
      MutableRef.set(suspender, running.suspend);

      yield* running.exit.pipe(
        Effect.exit,
        Effect.flatMap((result) => Deferred.done(exit, result)),
        Effect.andThen(Effect.sync(wakeWaits)),
        Effect.forkIn(scope),
      );
    }

    yield* yieldWhenDisplaced(session, run);
    yield* awaitPrevious;

    return Option.some(generation);
  });

  /** What the capability service is asked about `session`'s source for `intent`. */
  const capabilityRequest = (
    session: Session,
    intent: VideoIntent,
    excluded: ReadonlySet<ImplId>,
  ): TranscodeCapabilities.Request | undefined => {
    const video = session.file.probe.video;

    return video === undefined
      ? undefined
      : {
          scope: session.evidence,
          path: session.file.path,
          stream: video.index,
          source: sourceOf(video),
          intent,
          excluded,
        };
  };

  /**
   * Puts `next` in place of the stream's video plan, records why, and reports a change of mode
   * (from a GPU to software, say); a replacement that stays on its GPU keeps its mode.
   */
  const replaceVideo = Effect.fnUntraced(function* (
    session: Session,
    next: VideoPlan,
    change: Omit<PipelineChange, "at">,
  ) {
    const from = modeOf(yield* Ref.get(session.video), session.audio);
    const to = modeOf(next, session.audio);
    const at = yield* Clock.currentTimeMillis;

    yield* Ref.set(session.video, next);
    yield* Ref.update(session.changes, (known) => [...known, { ...change, at }]);
    yield* Effect.logWarning("StreamSessions.pipeline_replaced").pipe(
      Effect.annotateLogs({
        sessionId: session.sessionId,
        streamId: session.streamId,
        generation: change.generation,
        cause: change.cause,
        reason: change.reason,
        excluded: change.excluded.join(","),
        stages: isEncode(next) ? next.pipeline.steps.map((step) => step.impl).join(",") : "copy",
        from,
        to,
      }),
    );

    if (from !== to) {
      yield* reporter.report(
        PlaybackReporter.PlaybackEvent.cases.ModeChanged.make({
          sessionId: session.sessionId,
          userId: session.userId,
          fileId: session.fileId,
          streamId: session.streamId,
          from,
          to,
          reason: "hardware-unavailable",
        }),
      );
    }
  });

  /**
   * The video plan a new run of `session` uses: its current one while every capability it uses is
   * still verified, otherwise a strict replan, which costs no retry. False when nothing changed.
   */
  const recheckVideo = Effect.fnUntraced(function* (session: Session, generation: number) {
    const video = yield* Ref.get(session.video);
    const stream = session.file.probe.video;

    if (!isEncode(video) || stream === undefined) return false;
    const { excluded } = yield* Ref.get(session.recovery);
    const asked = capabilityRequest(session, video.intent, excluded);

    if (asked === undefined) return false;
    const snapshot = yield* capabilities.current(asked);

    if (stillVerified(video.pipeline, snapshot)) return false;
    const next = replan(stream, video.intent, snapshot);

    if (Result.isFailure(next)) return yield* new UnsupportedPlayback({ reason: next.failure });

    yield* replaceVideo(session, next.success, {
      generation: generation + 1,
      cause: "capability-lost",
      excluded: [],
      reason: "capability-lost",
    });

    return true;
  });

  /**
   * A run of `generation` failed before `index` was ready. Unless a newer generation replaced it
   * meanwhile, which leaves everything as it is, the capability service diagnoses the failure and
   * the stream replans without what it points at: once for the suspects, once without any GPU,
   * then it gives up with `TranscodeFailed`. A replacement keeps the audio, the burned subtitle,
   * the output intent, and the caps, and starts at the segment that was waited on.
   */
  const encoderFailed = Effect.fn("StreamSessions.encoderFailed")(function* (
    session: Session,
    generation: Generation,
    index: number,
    failure: MediaTools.MediaToolFailed,
  ): Effect.fn.Return<
    never,
    StreamGenerationGone | SegmentNotReady | StreamNotFound | TranscodeFailed | UnsupportedPlayback
  > {
    const restarted = yield* transition(session, () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(session.generation);

        if (current !== generation) return current;
        const encoder = yield* Ref.get(session.encoder);

        if (!Encoder.$is("Running")(encoder)) return yield* new SegmentNotReady({ index });
        const failed = MutableRef.get(generation.failed);

        if (Option.isSome(failed)) return yield* failed.value;
        const video = generation.video;
        const mode = modeOf(video, session.audio);
        const detail = failure.stderr.trim().slice(-300);

        yield* Effect.annotateCurrentSpan({
          streamId: session.streamId,
          mode,
          segmentIndex: index,
        });
        yield* Effect.logWarning(LogEvent.encoderFailed).pipe(
          Effect.annotateLogs({
            sessionId: session.sessionId,
            userId: session.userId,
            streamId: session.streamId,
            mode,
            generation: generation.number,
            exitCode: failure.exitCode,
            signal: failure.signal,
            first: firstLine(failure),
            detail,
          }),
        );

        const terminal = (reason: TranscodeReason) =>
          new TranscodeFailed({ streamId: session.streamId, mode, reason });

        const stream = session.file.probe.video;

        if (!isEncode(video) || generation.owners === undefined || stream === undefined) {
          return yield* giveUp(session, generation, index, terminal("other"));
        }

        const state = yield* Ref.get(session.recovery);
        const asked = capabilityRequest(session, video.intent, state.excluded);

        if (asked === undefined)
          return yield* giveUp(session, generation, index, terminal("other"));

        const diagnosis = yield* capabilities.diagnose({
          request: asked,
          pipeline: video.pipeline,
          owners: generation.owners,
          failure: {
            exitCode: failure.exitCode,
            signal: failure.signal,
            stderrTail: failure.stderr,
          },
        });

        const next = advance(state, diagnosis, video.pipeline);
        const reason = reasonOf(diagnosis);

        if (Recovery.$is("GiveUp")(next))
          return yield* giveUp(session, generation, index, terminal(reason));
        const snapshot = yield* capabilities.current({ ...asked, excluded: next.state.excluded });
        const replanned = replan(stream, video.intent, snapshot);

        // Nothing left can encode the file: the stream ends, as a resume that finds no chain does.
        if (Result.isFailure(replanned)) {
          return yield* new UnsupportedPlayback({ reason: replanned.failure });
        }

        if (samePipeline(replanned.success.pipeline, video.pipeline)) {
          return yield* giveUp(session, generation, index, terminal(reason));
        }

        yield* Ref.set(session.recovery, next.state);
        yield* replaceVideo(session, replanned.success, {
          generation: generation.number + 1,
          cause: causeOf(diagnosis),
          excluded: [...next.state.excluded].filter((impl) => !state.excluded.has(impl)),
          reason,
        });

        // A replacement whose ffmpeg never starts leaves no generation to attach to.
        return yield* nextGeneration(session, encoder, generation.number + 1, index).pipe(
          Effect.catchTag("SegmentNotReady", () =>
            Ref.get(session.generation).pipe(
              Effect.flatMap((replacement) =>
                giveUp(
                  session,
                  replacement,
                  index,
                  new TranscodeFailed({
                    streamId: session.streamId,
                    mode: modeOf(replanned.success, session.audio),
                    reason: "not-started",
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    );

    return yield* new StreamGenerationGone({
      streamId: session.streamId,
      generation: generation.number,
      currentGeneration: restarted.number,
    });
  });

  const awaitSegment = Effect.fn("StreamSessions.awaitSegment")(function* (
    session: Session,
    generation: Generation,
    index: number,
    maxWait: Duration.Duration,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(maxWait);

    for (;;) {
      const failed = MutableRef.get(generation.failed);

      if (Option.isSome(failed)) return yield* failed.value;
      const current = yield* Ref.get(session.generation);

      if (current.number !== generation.number) {
        return yield* new StreamGenerationGone({
          streamId: session.streamId,
          generation: generation.number,
          currentGeneration: current.number,
        });
      }

      const wake = MutableRef.get(generation.wake);
      const finished = yield* Deferred.isDone(generation.exit);
      const parsed = yield* parsedNewFragments(generation);
      const stopped = isClosed(generation.scope);

      if (isClosed(session.scope)) return yield* new StreamNotFound({ streamId: session.streamId });
      const fragments = yield* Ref.get(generation.fragments);
      const produced = producedRange(session, generation, fragments);
      const next = session.plan.starts[index + 1];

      const { followed, written } = reachOf(fragments, next);

      const readiness: Readiness =
        generation.onGpu && index === generation.startSegment ? "followed" : "written";

      // A fragment that failed to parse this time may belong to the segment, so only an encoder
      // that started the next one proves the segment whole.
      const ready = readiness === "written" && parsed ? written : followed;

      if (finished) {
        const result = yield* Deferred.await(generation.exit).pipe(Effect.exit);

        if (Exit.isFailure(result) && !ready) {
          const failure = Exit.findErrorOption(result);
          const neverServed = !(yield* Ref.get(session.served));

          const recovering: Effect.Effect<
            never,
            | StreamGenerationGone
            | SegmentNotReady
            | StreamNotFound
            | TranscodeFailed
            | UnsupportedPlayback
          > = Option.match(failure, {
            onNone: () =>
              Effect.fail(
                new TranscodeFailed({
                  streamId: session.streamId,
                  mode: modeOf(generation.video, session.audio),
                  reason: "other",
                }),
              ),
            onSome: (cause) => encoderFailed(session, generation, index, cause),
          });

          // A stream that served nothing ends with its failure. One that served ends when nothing
          // can take it over; the request that met that end hears why, later ones that the stream
          // is gone.
          return yield* recovering.pipe(
            Effect.tapErrorTag("TranscodeFailed", () =>
              neverServed ? closeSession(session, "failed") : Effect.void,
            ),
            Effect.catchTag("UnsupportedPlayback", (refused) => {
              const ended = new TranscodeFailed({
                streamId: session.streamId,
                mode: modeOf(generation.video, session.audio),
                reason: "nothing-left",
              });

              return Effect.logWarning("StreamSessions.nothing_left").pipe(
                Effect.annotateLogs({ streamId: session.streamId, refused: refused.reason }),
                Effect.andThen(
                  Effect.sync(() => MutableRef.set(generation.failed, Option.some(ended))),
                ),
                Effect.andThen(closeSession(session, "failed")),
                Effect.andThen(Effect.fail(ended)),
              );
            }),
          );
        }
      }

      if (finished || ready) {
        const members = produced.members.get(index) ?? [];

        if (members.length === 0) {
          const mode = modeOf(generation.video, session.audio);
          const planned = session.plan.starts[index] ?? session.plan.end;

          yield* Effect.logWarning("StreamSessions.segment_not_cut").pipe(
            Effect.annotateLogs({
              sessionId: session.sessionId,
              userId: session.userId,
              streamId: session.streamId,
              mode,
              generation: generation.number,
              segmentIndex: index,
              plannedSeconds: planned,
            }),
          );

          return yield* new TranscodeFailed({
            streamId: session.streamId,
            mode,
            reason: "segment-not-cut",
          });
        }

        yield* Ref.set(session.served, true);
        yield* Ref.update(session.recovery, (state) =>
          state.failures === 0 ? state : { ...state, failures: 0 },
        );
        yield* Ref.update(session.ended, (known) =>
          known.has(index) ? without(known, index) : known,
        );

        return members.map((fragment) => fragment.path);
      }

      if (stopped || (yield* Clock.currentTimeMillis) > deadline) {
        // A replacement is published before the run it replaces is stopped, so a run found
        // stopped after the check above may have been replaced meanwhile: its reader moves on.
        const latest = yield* Ref.get(session.generation);

        if (latest.number !== generation.number) {
          return yield* new StreamGenerationGone({
            streamId: session.streamId,
            generation: generation.number,
            currentGeneration: latest.number,
          });
        }

        return yield* new SegmentNotReady({ index });
      }

      yield* Deferred.await(wake).pipe(Effect.timeoutOption(pollInterval));
    }
  });

  const pauseAhead = Duration.toSeconds(config.streamBufferAhead);

  const throttle = Effect.fnUntraced(function* (session: Session) {
    if (!Encoder.$is("Running")(yield* Ref.get(session.encoder))) return;
    const generation = yield* Ref.get(session.generation);

    if (generation.number === 0 || (yield* Deferred.isDone(generation.exit))) return;
    yield* parsedNewFragments(generation);
    const produced = producedRange(session, generation, yield* Ref.get(generation.fragments));
    const requested = yield* Ref.get(session.requested);
    const startOf = (index: number) => session.plan.starts[index] ?? session.plan.end;
    const ahead = startOf(produced.head) - startOf(requested);
    const paused = yield* Ref.get(generation.paused);

    if (isClosed(generation.scope)) return;

    if (!paused && ahead > pauseAhead) {
      yield* generation.suspend(true);
      yield* Ref.set(generation.paused, true);
    } else if (paused && ahead < pauseAhead / 2) {
      yield* generation.suspend(false);
      yield* Ref.set(generation.paused, false);
    }
  });

  const lookup = Effect.fn("StreamSessions.lookup")(function* (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) {
    const session = (yield* Ref.get(sessions)).get(streamId);

    if (session === undefined) return yield* new StreamNotFound({ streamId });

    if (session.sessionId !== grant.sessionId || session.fileId !== grant.fileId) {
      return yield* new StreamAccessDenied({ streamId });
    }

    return session;
  });

  /** Counts a request in, with its token's expiry, unless the stream began to close. */
  const admit = (session: Session, expiresAt: number) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.modify(session.use, (use) =>
          use.admitting
            ? ([
                true,
                {
                  ...use,
                  inFlight: use.inFlight + 1,
                  lastRequestAt: now,
                  expiresAt: Math.max(use.expiresAt, expiresAt),
                },
              ] as const)
            : ([false, use] as const),
        ),
      ),
      Effect.flatMap((admitted) =>
        admitted ? Effect.void : Effect.fail(new StreamNotFound({ streamId: session.streamId })),
      ),
    );

  const leave = (session: Session) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(session.use, (use) => ({
          ...use,
          inFlight: use.inFlight - 1,
          lastRequestAt: now,
        })),
      ),
    );

  const using = <A, E, R>(
    streamId: StreamId,
    grant: PlaybackGrant,
    notReady: (session: Session) => number,
    f: (session: Session) => Effect.Effect<A, E, R>,
  ) =>
    lookup(streamId, grant).pipe(
      Effect.flatMap((session) =>
        Effect.acquireUseRelease(
          admit(session, grant.expiresAt),
          () =>
            f(session).pipe(
              stopWaitingAfter(
                SEGMENT_WAIT,
                () => new SegmentNotReady({ index: notReady(session) }),
              ),
            ),
          () => leave(session),
        ),
      ),
    );

  const currentGeneration = Effect.fnUntraced(function* (session: Session, generation: number) {
    const current = yield* Ref.get(session.generation);

    if (current.number !== generation) {
      return yield* new StreamGenerationGone({
        streamId: session.streamId,
        generation,
        currentGeneration: current.number,
      });
    }

    return current;
  });

  const firstSegment = Effect.fn("StreamSessions.firstSegment")(function* (
    session: Session,
    started: Generation,
    segmentIndex: number,
  ) {
    yield* Effect.annotateCurrentSpan({ streamId: session.streamId, segmentIndex });
    let generation = started;

    // The first run and the two replacements recovery may start.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ready = yield* awaitSegment(session, generation, segmentIndex, START_WAIT).pipe(
        Effect.as(true),
        Effect.catchTags({
          StreamGenerationGone: () => Effect.succeed(false),
          SegmentNotReady: () => Effect.succeed(true),
        }),
      );

      if (ready) break;
      generation = yield* Ref.get(session.generation);
    }

    yield* Effect.annotateCurrentSpan({
      mode: modeOf(yield* Ref.get(session.video), session.audio),
    });

    return generation;
  });

  const claimRun = (
    stream: Lifecycle,
    transcoding: boolean,
    audience: EncoderSlots.Audience,
    claimant: EncoderSlots.Claimant,
    wait: Duration.Duration,
    callerGone: Effect.Effect<void>,
  ): Effect.Effect<Run, TranscodeCapacityReached | StreamNotFound> => {
    const pool = transcoding ? transcodes : copies;
    const full = () => new TranscodeCapacityReached({ limit: pool.limit });

    return openRun(stream).pipe(
      Effect.flatMap((opened) =>
        (audience === "household"
          ? pool.household(opened.scope, claimant)
          : pool
              .guest(opened.scope, claimant)
              .pipe(
                stopWaitingAfter(wait, full),
                Effect.raceFirst(callerGone.pipe(Effect.andThen(Effect.fail(full())))),
                Effect.interruptible,
              )
        ).pipe(
          Effect.map((held): Run => ({ ...opened, held })),
          Effect.onError(() => beginStop(stream, opened)),
        ),
      ),
    );
  };

  const nextGeneration = Effect.fnUntraced(function* (
    session: Session,
    encoder: Encoder & { readonly _tag: "Running" },
    number: number,
    index: number,
  ) {
    const opened = yield* openRun(session);
    const run: Run = { ...opened, held: yield* encoder.run.held.renew(opened.scope) };

    const started = yield* startGeneration(
      session,
      run,
      Option.some(encoder.run),
      number,
      index,
    ).pipe(
      Effect.onError(() =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((since) =>
            Ref.set(session.encoder, Encoder.Released({ since, keptInit: Option.none() })),
          ),
          Effect.andThen(beginStop(session, run)),
          Effect.andThen(beginStop(session, encoder.run)),
        ),
      ),
    );

    if (Option.isNone(started)) {
      yield* stopEncoder(session, run, Option.none());

      return yield* new SegmentNotReady({ index });
    }

    yield* Ref.set(session.encoder, Encoder.Running({ run }));

    return started.value;
  });

  const revive = Effect.fn("StreamSessions.revive")(function* (
    session: Session,
    released: Encoder & { readonly _tag: "Released" },
    index: number,
    callerGone: Effect.Effect<void>,
  ) {
    yield* unlessEnded(session, index);
    const current = yield* Ref.get(session.generation);
    const transcoding = isEncode(yield* Ref.get(session.video));

    const annotations = {
      sessionId: session.sessionId,
      userId: session.userId,
      streamId: session.streamId,
      generation: current.number,
      segment: index,
    };

    const end = (reason: PlaybackReporter.StreamEndReason) =>
      closeSession(session, reason).pipe(
        Effect.andThen(Effect.fail(new StreamNotFound({ streamId: session.streamId }))),
      );

    const refused = (reason: "TranscodeCapacityReached" | "InsufficientTranscodeSpace") =>
      Effect.logWarning(LogEvent.resumeRefused).pipe(
        Effect.annotateLogs({ ...annotations, reason, slots: transcoding ? "transcode" : "remux" }),
        Effect.andThen(end("resume-refused")),
      );

    const claimed = yield* space.check(0).pipe(
      Effect.andThen(
        claimRun(
          session,
          transcoding,
          session.audience,
          { sessionId: session.sessionId, ticket: session.ticket },
          SEGMENT_WAIT,
          callerGone,
        ),
      ),
      Effect.catchTags({
        TranscodeCapacityReached: () =>
          session.audience === "household"
            ? refused("TranscodeCapacityReached")
            : Effect.fail(new SegmentNotReady({ index })),
        InsufficientTranscodeSpace: () => refused("InsufficientTranscodeSpace"),
      }),
    );

    // The player holds this generation's init segment, and segments from another chain may not
    // decode under it, so a chain that changed because a capability it used was lost moves to the
    // next generation. When nothing can play the file any more, the negotiation the player falls
    // back to says why.
    const started = yield* Effect.gen(function* () {
      const lost = yield* recheckVideo(session, current.number);

      yield* Ref.update(session.recovery, (state) => ({ ...state, failures: 0 }));

      return yield* startGeneration(
        session,
        claimed,
        Option.none(),
        current.number + (lost ? 1 : 0),
        index,
      );
    }).pipe(
      Effect.onError(() => beginStop(session, claimed)),
      Effect.catchTag("UnsupportedPlayback", () => end("failed")),
    );

    if (Option.isNone(started)) {
      yield* stopEncoder(session, claimed, Option.none());

      return yield* new SegmentNotReady({ index });
    }

    const run = started.value;

    yield* Ref.set(session.encoder, Encoder.Running({ run: claimed }));

    yield* Effect.logInfo(LogEvent.streamResumed).pipe(
      Effect.annotateLogs({
        ...annotations,
        generation: run.number,
        fromSeconds: session.plan.starts[index] ?? session.plan.end,
        releasedForMs: (yield* Clock.currentTimeMillis) - released.since,
      }),
    );

    return run;
  });

  const ensureCovers = Effect.fn("StreamSessions.ensureCovers")(function* (
    session: Session,
    index: number,
  ) {
    return yield* transition(session, (callerGone) =>
      Effect.gen(function* () {
        const encoder = yield* Ref.get(session.encoder);

        if (Encoder.$is("Released")(encoder)) {
          return yield* revive(session, encoder, index, callerGone);
        }

        const current = yield* Ref.get(session.generation);
        yield* parsedNewFragments(current);
        const produced = producedRange(session, current, yield* Ref.get(current.fragments));

        if (index >= current.startSegment && index <= produced.head + LOOKAHEAD_SEGMENTS)
          return current;

        yield* unlessEnded(session, index);
        yield* recheckVideo(session, current.number);
        yield* Ref.update(session.recovery, (state) => ({ ...state, failures: 0 }));

        return yield* nextGeneration(session, encoder, current.number + 1, index);
      }),
    );
  });

  const keepInit = Effect.fnUntraced(function* (session: Session, run: Generation) {
    const known = (yield* Ref.get(session.keptInits)).get(run.number);

    if (known !== undefined) return Option.some(known);
    yield* refreshFragments(run);

    const file = keptInitOf(session, run.number);
    const temporary = `${file}.tmp`;

    // ffmpeg's HLS muxer finishes `init.mp4` only when it writes the first fragment. The bytes are
    // written here rather than with `copyFile`, whose libuv implementation calls `fchown`: the
    // NixOS unit's system call filter denies it, which once killed the service and every stream.
    const copied =
      (yield* Ref.get(run.fragments)).length > 0 &&
      (yield* fs.readFile(path.join(run.directory, "init.mp4")).pipe(
        Effect.andThen((bytes) => fs.writeFile(temporary, bytes)),
        Effect.andThen(fs.rename(temporary, file)),
        Effect.as(true),
        Effect.catch(() => fs.remove(temporary).pipe(Effect.ignore, Effect.as(false))),
      ));

    if (!copied) return Option.none<KeptInit>();

    const made: KeptInit = {
      generation: run.number,
      file,
      readers: yield* Scope.make(),
      draining: MutableRef.make(false),
      drained: yield* Deferred.make<void>(),
    };

    return Option.some(
      yield* Ref.modify(session.keptInits, (current) => {
        const existing = current.get(run.number);

        return existing === undefined
          ? ([made, new Map(current).set(run.number, made)] as const)
          : ([existing, current] as const);
      }),
    );
  });

  /** Reads a kept init on a reader its deletion waits for; none once its deletion began. */
  const readKept = (kept: KeptInit) =>
    finishOnceStarted(Effect.option(fs.readFile(kept.file))).pipe(
      Effect.forkIn(kept.readers),
      Effect.flatMap(awaitReader),
      Effect.map(Option.flatten),
    );

  /** Deletes the init kept for `generation` once its reads end, without the caller waiting. */
  const retireKeptInit = (stream: Lifecycle, generation: number) =>
    Ref.get(stream.keptInits).pipe(
      Effect.flatMap((current) => {
        const kept = current.get(generation);

        return kept === undefined
          ? Effect.void
          : drain(kept).pipe(
              Effect.andThen(fs.remove(kept.file).pipe(Effect.ignore)),
              Effect.forkDetach,
              Effect.asVoid,
            );
      }),
    );

  const keepInitWithin = (session: Session, run: Generation) =>
    readerOf(run, keepInit(session, run)).pipe(
      Effect.map(Option.flatten),
      Effect.timeoutOption(KEEP_INIT_WAIT),
      Effect.map(Option.flatten),
    );

  const stopEncoder = Effect.fnUntraced(function* (
    session: Session,
    run: Run,
    keptInit: Option.Option<KeptInit>,
  ) {
    yield* Ref.set(
      session.encoder,
      Encoder.Released({ since: yield* Clock.currentTimeMillis, keptInit }),
    );
    yield* beginStop(session, run);
    yield* awaitExited(run);
  });

  const yieldEncoder = Effect.fn("StreamSessions.yieldEncoder")(function* (
    session: Session,
    run: Run,
  ) {
    yield* transition(session, () =>
      Effect.gen(function* () {
        const encoder = yield* Ref.get(session.encoder);

        if (!Encoder.$is("Running")(encoder) || encoder.run !== run) return;
        const current = yield* Ref.get(session.generation);
        const keptInit = yield* keepInitWithin(session, current);

        yield* Effect.logInfo(LogEvent.streamYielded).pipe(
          Effect.annotateLogs({
            sessionId: session.sessionId,
            userId: session.userId,
            streamId: session.streamId,
            generation: current.number,
            segment: yield* Ref.get(session.requested),
          }),
        );

        yield* stopEncoder(session, run, keptInit);
      }),
    );
  });

  const yieldWhenDisplaced = (session: Session, run: Run) =>
    session.audience === "guest"
      ? run.held.displaced.pipe(
          Effect.andThen(yieldEncoder(session, run)),
          Effect.ignore,
          Effect.forkIn(run.scope),
          Effect.asVoid,
        )
      : Effect.void;

  const release = Effect.fn("StreamSessions.release")(function* (session: Session) {
    yield* transitionIfIdle(session, () =>
      Effect.gen(function* () {
        const encoder = yield* Ref.get(session.encoder);

        if (!Encoder.$is("Running")(encoder)) return;

        if (StreamLiveness.holdsEncoder(yield* snapshotOf(session))) return;
        const current = yield* Ref.get(session.generation);
        const keptInit = yield* keepInitWithin(session, current);
        const moment = yield* snapshotOf(session);

        if (StreamLiveness.holdsEncoder(moment)) return;

        yield* stopEncoder(session, encoder.run, keptInit);

        yield* Effect.logInfo(LogEvent.streamReleased).pipe(
          Effect.annotateLogs({
            sessionId: session.sessionId,
            userId: session.userId,
            streamId: session.streamId,
            generation: current.number,
            segment: yield* Ref.get(session.requested),
            liveness: moment.liveness,
            inFlight: moment.inFlight,
            lastRequestAgeMs: moment.lastRequestAgeMs,
            lastProgressAgeMs: moment.lastProgressAgeMs,
          }),
        );
      }),
    ).pipe(Effect.catchTag("StreamNotFound", () => Effect.void));
  });

  /**
   * Unless a newer negotiation of the session began, takes the session's streams out of the
   * registry and registers `next` in their place; none when one did.
   */
  const replaceStreams = (
    sessionId: PlaybackSessionId,
    ticket: number,
    next: Option.Option<Session>,
  ) =>
    registry.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(negotiations)).latest.get(sessionId) !== ticket) {
          return Option.none<ReadonlyArray<Session>>();
        }

        const previous = yield* Ref.modify(sessions, (current) => {
          const replaced = [...current.values()].filter(
            (existing) => existing.sessionId === sessionId,
          );

          const updated = new Map(current);

          for (const existing of replaced) updated.delete(existing.streamId);

          if (Option.isSome(next)) updated.set(next.value.streamId, next.value);

          return [replaced, updated] as const;
        });

        yield* Effect.forEach(previous, (existing) => owners.closed(existing.streamId), {
          discard: true,
        });

        if (Option.isSome(next)) {
          yield* owners.opened(next.value.streamId, sessionId);
        }

        return Option.some(previous);
      }),
    );

  const endReplaced = (previous: ReadonlyArray<Session>) =>
    Effect.forEach(
      previous,
      (existing) =>
        Effect.gen(function* () {
          yield* stopAdmitting(existing, () => true);
          yield* teardown(existing).pipe(Effect.ensuring(reportEnded(existing, "replaced")));
        }),
      { discard: true },
    );

  const start = Effect.fn("StreamSessions.start")(function* (
    grant: PlaybackGrant,
    ticket: number,
    request: StartRequest,
  ) {
    const streamId = yield* newStreamId;

    const stream: Lifecycle = {
      streamId,
      scope: yield* Scope.make("sequential"),
      runs: yield* Ref.make<Runs>({ live: new Map(), sealed: false }),
      keptInits: yield* Ref.make<ReadonlyMap<number, KeptInit>>(new Map()),
      serverRunsAwaitingExit: awaitingExit,
      directory: path.join(config.transcodeDir, streamId),
      torndown: yield* Deferred.make<void>(),
    };

    const registered = yield* Ref.make(Option.none<Session>());
    const lostSlot = yield* Ref.make(false);
    const limit = (isEncode(request.plan.video) ? transcodes : copies).limit;

    return yield* startIn(stream, registered, lostSlot, grant, ticket, request).pipe(
      stopWaitingAfter(startWait, () => new TranscodeCapacityReached({ limit })),
      Effect.onExit((exit) =>
        Ref.get(registered).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => (Exit.isSuccess(exit) ? Effect.void : teardown(stream)),
              onSome: (session) =>
                Exit.isSuccess(exit)
                  ? leave(session)
                  : Ref.get(lostSlot).pipe(
                      Effect.flatMap((lost) => closeSession(session, endOfStart(exit.cause, lost))),
                    ),
            }),
          ),
        ),
      ),
    );
  });

  const startIn = Effect.fnUntraced(function* (
    stream: Lifecycle,
    registered: Ref.Ref<Option.Option<Session>>,
    lostSlot: Ref.Ref<boolean>,
    grant: PlaybackGrant,
    ticket: number,
    request: StartRequest,
  ) {
    const { file, plan } = request;

    const transcoding = isEncode(plan.video);
    const { streamId, scope } = stream;

    yield* space.check(0);

    const quickStart = file.probe.startSeconds + request.startSeconds;

    const segmentPlan = isEncode(plan.video)
      ? planGridSegments(file.probe.startSeconds, file.probe.durationSeconds, { quickStart })
      : planKeyframeSegments(
          request.keyframes ?? (yield* keyframes.keyframes(file)),
          file.probe.startSeconds,
          file.probe.durationSeconds,
          { quickStart },
        );

    const run = yield* claimRun(
      stream,
      transcoding,
      grant.audience,
      { sessionId: grant.sessionId, ticket },
      START_WAIT,
      Effect.never,
    );

    const placeholder: Generation = {
      number: 0,
      streamId,
      onGpu: false,
      video: plan.video,
      owners: undefined,
      failed: MutableRef.make(Option.none<TranscodeFailed>()),
      startSegment: 0,
      from: segmentPlan.starts[0] ?? segmentPlan.end,
      directory: "",
      scope: run.scope,
      readers: run.readers,
      files: run.files,
      exit: yield* Deferred.make<void, MediaTools.MediaToolFailed>(),
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      wake: MutableRef.make(Deferred.makeUnsafe<void>()),
      refreshing: MutableRef.make(Option.none<Refresh>()),
      endUnknownLogged: MutableRef.make(false),
      videoTiming: MutableRef.make(Option.none<VideoTiming>()),
      suspend: () => Effect.void,
      paused: yield* Ref.make(false),
    };

    const now = yield* Clock.currentTimeMillis;

    const session: Session = {
      ...stream,
      sessionId: grant.sessionId,
      ticket,
      audience: grant.audience,
      userId: grant.userId,
      fileId: grant.fileId,
      file,
      client: request.client,
      audioIndex: request.audioIndex,
      quality: request.quality,
      burnSubtitle: request.burnSubtitle,
      plan: segmentPlan,
      video: yield* Ref.make(plan.video),
      audio: plan.audio,
      evidence: sourceScope(
        file.fileId,
        file.sizeBytes,
        file.modifiedAtMs,
        file.probe.video?.index ?? 0,
      ),
      recovery: yield* Ref.make<RecoveryState>(recovered),
      changes: yield* Ref.make<ReadonlyArray<PipelineChange>>([]),
      ended: yield* Ref.make<ReadonlyMap<number, TranscodeFailed>>(new Map()),

      generation: yield* Ref.make(placeholder),
      lane: yield* Semaphore.make(1),
      encoder: yield* Ref.make<Encoder>(Encoder.Running({ run })),
      use: yield* Ref.make<Admission>({
        inFlight: 1,
        lastRequestAt: now,
        expiresAt: grant.expiresAt,
        admitting: true,
      }),
      liveness: yield* Ref.make<StreamLiveness.Liveness>(StreamLiveness.Liveness.Unknown()),
      requested: yield* Ref.make(0),
      served: yield* Ref.make(false),
      runFolders: yield* Ref.make(0),
    };

    yield* throttle(session).pipe(
      Effect.repeat(Schedule.spaced(THROTTLE_INTERVAL)),
      Effect.forkIn(scope),
    );

    const replaced = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const previous = yield* replaceStreams(grant.sessionId, ticket, Option.some(session));

        if (Option.isSome(previous)) {
          yield* Ref.set(registered, Option.some(session));
          yield* endReplaced(previous.value);
        }

        return previous;
      }),
    );

    if (Option.isNone(replaced)) return yield* new StreamNotFound({ streamId });

    yield* reports.follow(grant.sessionId).pipe(
      Stream.takeUntil(StreamLiveness.SessionReport.$is("Ended")),
      Stream.runForEach((report) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            Ref.update(session.liveness, (known) => StreamLiveness.hear(known, report, at)),
          ),
        ),
      ),
      Effect.andThen(closeSession(session, "session-ended")),
      Effect.forkIn(scope),
    );

    const segmentIndex = segmentAt(segmentPlan, quickStart);

    const refused = () =>
      new TranscodeCapacityReached({ limit: (transcoding ? transcodes : copies).limit });

    const first = yield* transition(session, () =>
      startGeneration(session, run, Option.none(), 1, segmentIndex),
    );

    if (Option.isNone(first)) {
      yield* Ref.set(lostSlot, true);

      return yield* refused();
    }

    const generation = onGpu(plan.video)
      ? yield* firstSegment(session, first.value, segmentIndex)
      : first.value;

    const video = yield* Ref.get(session.video);
    const mode = modeOf(video, session.audio);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
        sessionId: grant.sessionId,
        userId: grant.userId,
        fileId: grant.fileId,
        streamId,
        mode,
      }),
    );

    return {
      streamId,
      generation: generation.number,
      mode,
      video,
      transcode: summaryOf(video, yield* Ref.get(session.changes), generation.number),
      segmentIndex,
    } satisfies StartedStream;
  });

  const playlist = Effect.fn("StreamSessions.playlist")(function* (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) {
    return yield* using(streamId, grant, noSegment, (session) =>
      currentGeneration(session, generation).pipe(
        Effect.as({ streamId, generation, plan: session.plan } satisfies StreamView),
      ),
    );
  });

  const initSource = Effect.fn("StreamSessions.initSource")(function* (
    session: Session,
    generation: number,
  ) {
    return yield* transition(session, (callerGone) =>
      Effect.gen(function* () {
        const current = yield* currentGeneration(session, generation);
        const failed = MutableRef.get(current.failed);

        if (Option.isSome(failed)) return yield* failed.value;
        const encoder = yield* Ref.get(session.encoder);

        if (Encoder.$is("Running")(encoder)) return InitSource.Run({ run: current });

        if (Option.isSome(encoder.keptInit)) {
          return InitSource.Kept({ kept: encoder.keptInit.value });
        }

        yield* revive(session, encoder, yield* Ref.get(session.requested), callerGone);

        return InitSource.Run({ run: yield* currentGeneration(session, generation) });
      }),
    );
  });

  const init = Effect.fn("StreamSessions.init")(function* (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) {
    return yield* using(streamId, grant, noSegment, (session) =>
      Effect.gen(function* () {
        const bytes = yield* InitSource.$match(yield* initSource(session, generation), {
          Kept: ({ kept }) => readKept(kept),
          Run: ({ run }) =>
            awaitSegment(session, run, run.startSegment, SEGMENT_WAIT).pipe(
              Effect.andThen(
                readerOf(run, Effect.option(fs.readFile(path.join(run.directory, "init.mp4")))),
              ),
              Effect.map(Option.flatten),
            ),
        });

        if (Option.isSome(bytes)) return bytes.value;
        yield* currentGeneration(session, generation);

        return yield* new SegmentNotReady({ index: -1 });
      }),
    );
  });

  const serve = Effect.fnUntraced(function* (
    generation: Generation,
    index: number,
    paths: ReadonlyArray<string>,
  ) {
    const caller = yield* Effect.scope;

    const opened = yield* readerOf(
      generation,
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        const serving = yield* Scope.fork(generation.files);

        yield* Scope.addFinalizer(serving, Deferred.await(released));
        yield* Scope.addFinalizer(
          caller,
          Deferred.succeed(released, undefined).pipe(
            Effect.andThen(Scope.close(serving, Exit.void)),
          ),
        );

        return yield* Effect.forEach(paths, (part) =>
          fs
            .open(part)
            .pipe(
              Effect.flatMap((file) =>
                file.stat.pipe(
                  Effect.map((info): ServedPart => ({ file, sizeBytes: Number(info.size) })),
                ),
              ),
            ),
        ).pipe(Scope.provide(caller), Effect.option);
      }),
    ).pipe(Effect.map(Option.flatten));

    if (Option.isNone(opened)) return yield* new SegmentNotReady({ index });

    return {
      parts: opened.value,
      sizeBytes: opened.value.reduce((total, part) => total + part.sizeBytes, 0),
    } satisfies ServedSegment;
  });

  const segment = Effect.fn("StreamSessions.segment")(function* (
    streamId: StreamId,
    generation: number,
    index: number,
    grant: PlaybackGrant,
  ) {
    return yield* using(
      streamId,
      grant,
      () => index,
      (session) =>
        Effect.gen(function* () {
          if (!Number.isInteger(index) || index < 0 || index >= session.plan.starts.length) {
            return yield* new SegmentNotFound({ index });
          }

          yield* currentGeneration(session, generation);
          yield* Ref.update(session.requested, (furthest) => Math.max(furthest, index));
          const covering = yield* ensureCovers(session, index);

          if (covering.number !== generation) {
            return yield* new StreamGenerationGone({
              streamId,
              generation,
              currentGeneration: covering.number,
            });
          }

          return yield* serve(
            covering,
            index,
            yield* awaitSegment(session, covering, index, SEGMENT_WAIT),
          );
        }),
    );
  });

  const seek = Effect.fn("StreamSessions.seek")(function* (
    streamId: StreamId,
    seconds: number,
    grant: PlaybackGrant,
  ) {
    const indexOf = (session: Session) =>
      segmentAt(session.plan, session.file.probe.startSeconds + seconds);

    return yield* using(streamId, grant, indexOf, (session) =>
      Effect.gen(function* () {
        const index = indexOf(session);
        const covering = yield* ensureCovers(session, index);
        yield* Effect.annotateCurrentSpan({
          streamId,
          segmentIndex: index,
          generation: covering.number,
        });

        const source = session.file.probe.video;

        if (source === undefined)
          return yield* new UnsupportedPlayback({ reason: "no-video-stream" });

        return {
          streamId,
          generation: covering.number,
          plan: session.plan,
          mode: modeOf(covering.video, session.audio),
          video: deliveredVideo(covering.video, source),
          transcode: summaryOf(covering.video, yield* Ref.get(session.changes), covering.number),
        } satisfies MovedStream;
      }),
    );
  });

  const stop = Effect.fn("StreamSessions.stop")(function* (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) {
    yield* closeSession(yield* lookup(streamId, grant), "stopped");
  });

  const negotiate = (grant: PlaybackGrant) =>
    Effect.acquireRelease(
      Ref.modify(negotiations, ({ issued, latest }) => {
        const ticket = issued + 1;

        return [
          ticket,
          { issued: ticket, latest: new Map(latest).set(grant.sessionId, ticket) },
        ] as const;
      }),
      (ticket) =>
        Ref.update(negotiations, ({ issued, latest }) => {
          if (latest.get(grant.sessionId) !== ticket) return { issued, latest };

          const next = new Map(latest);
          next.delete(grant.sessionId);

          return { issued, latest: next };
        }),
    ).pipe(
      Effect.map((ticket): Negotiation => ({
        start: (request) => start(grant, ticket, request),
        direct: replaceStreams(grant.sessionId, ticket, Option.none()).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (previous) => endReplaced(previous).pipe(Effect.as(true)),
            }),
          ),
          Effect.uninterruptible,
        ),
      })),
    );

  const expired: Condition = Clock.currentTimeMillis.pipe(
    Effect.map((now) => (use: StreamLiveness.Use) => StreamLiveness.isExpired(use, now)),
  );

  const unattended = (session: Session): Condition =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const liveness = yield* Ref.get(session.liveness);
      const encoder = yield* Ref.get(session.encoder);

      return (use: StreamLiveness.Use) =>
        Encoder.$is("Released")(encoder) &&
        StreamLiveness.isUnattended(use, liveness, encoder.since, now, idleMillis);
    });

  const sweep = Effect.fnUntraced(function* (session: Session) {
    const use = yield* Ref.get(session.use);

    if ((yield* expired)(use)) {
      yield* closeSession(session, "expired", expired);
    } else if ((yield* unattended(session))(use)) {
      yield* closeSession(session, "unattended", unattended(session));
    } else if (
      Encoder.$is("Running")(yield* Ref.get(session.encoder)) &&
      !StreamLiveness.holdsEncoder(yield* snapshotOf(session))
    ) {
      yield* release(session);
    }
  });

  yield* Ref.get(sessions).pipe(
    Effect.flatMap((current) => Effect.forEach(current.values(), sweep, { discard: true })),
    Effect.repeat(Schedule.spaced(Duration.millis(Math.min(5000, Math.max(100, idleMillis / 4))))),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Ref.get(sessions).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (session) => closeSession(session, "shutdown"), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );

  return Service.of({
    negotiate,
    playlist,
    init,
    segment,
    seek,
    stop,
    activeCount: Ref.get(sessions).pipe(
      Effect.flatMap((current) =>
        Effect.filter(current.values(), (session) =>
          Ref.get(session.encoder).pipe(Effect.map(Encoder.$is("Running"))),
        ),
      ),
      Effect.map((running) => running.length),
    ),
    runsAwaitingExit: Ref.get(awaitingExit),
  });
});

/** The session manager; closing the layer stops every stream and deletes its output. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | MediaTools.Service
  | KeyframeIndex.Service
  | TranscodeCapabilities.Service
  | PlaybackReporter.Service
  | TranscodeSpace.Service
  | StreamOwners.Service
  | SessionReports.Service
> = Layer.effect(Service, make);
