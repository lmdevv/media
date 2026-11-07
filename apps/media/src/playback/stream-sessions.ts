import {
  type ClientCapabilities,
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
import * as HardwareAcceleration from "./hardware-acceleration.ts";
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
import { AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import type { PlaybackGrant } from "./playback-token.ts";
import * as SessionReports from "./session-reports.ts";
import * as StreamLiveness from "./stream-liveness.ts";
import * as StreamOwners from "./stream-owners.ts";
import * as TranscodeSpace from "./transcode-space.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

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
  readonly generation: number;
  readonly mode: Exclude<PlaybackMode, "direct">;
  readonly segmentIndex: number;
}

interface StreamView {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly plan: SegmentPlan;
}

interface SegmentFiles {
  readonly paths: ReadonlyArray<string>;
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
  ) => Effect.Effect<SegmentFiles, StreamRequestError>;
  readonly segment: (
    streamId: StreamId,
    generation: number,
    index: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<SegmentFiles, StreamRequestError>;
  /** Moves playback to `seconds`, starting a new generation unless that point is already produced. */
  readonly seek: (
    streamId: StreamId,
    seconds: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<StreamView, StreamRequestError>;
  readonly stop: (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) => Effect.Effect<void, StreamNotFound | StreamAccessDenied>;
  /** Number of streams whose encoder runs; a released stream waiting for its player is not one. */
  readonly activeCount: Effect.Effect<number>;
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

const FIRST_RUN_WAIT = Duration.sum(
  Duration.times(Duration.sum(READY_WAIT, START_WAIT), 2),
  STOP_WAIT,
);

const FRAGMENT_FILE = /^f\d+\.m4s$/;

/**
 * When a segment counts as produced: `written` once its last fragment is, and `followed` once the
 * encoder has also started the next one. A hardware run's first segment, and so its init, waits
 * for `followed`, which shows the device got past its first fragment before any of its bytes
 * reach the player.
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
  /** Whether the run encodes on a GPU, whose failure falls back to software. */
  readonly hardware: boolean;
  readonly startSegment: number;
  readonly from: number;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly readers: Scope.Closeable;
  readonly exit: Deferred.Deferred<void, MediaTools.MediaToolFailed>;
  readonly fragments: Ref.Ref<ReadonlyArray<Fragment>>;
  readonly refreshLock: Semaphore.Semaphore;
  readonly wake: MutableRef.MutableRef<Deferred.Deferred<void>>;
  readonly endUnknownLogged: MutableRef.MutableRef<boolean>;
  /** The video timing read from the run's `init.mp4`, once its first fragment is written. */
  readonly videoTiming: MutableRef.MutableRef<Option.Option<VideoTiming>>;
  readonly suspend: (paused: boolean) => Effect.Effect<void>;
  readonly paused: Ref.Ref<boolean>;
}

interface RunScope {
  readonly scope: Scope.Closeable;
  readonly readers: Scope.Closeable;
  readonly files: Scope.Closeable;
  readonly stopping: MutableRef.MutableRef<boolean>;
  readonly stopped: Deferred.Deferred<void>;
}

interface Run extends RunScope {
  readonly held: EncoderSlots.Held;
}

interface Runs {
  readonly live: ReadonlyMap<Scope.Closeable, RunScope>;
  readonly sealed: boolean;
}

interface Lifecycle {
  readonly streamId: StreamId;
  readonly scope: Scope.Closeable;
  readonly runs: Ref.Ref<Runs>;
  readonly directory: string;
  readonly torndown: Deferred.Deferred<void>;
}

type Encoder = Data.TaggedEnum<{
  Running: { readonly run: Run };
  Released: { readonly since: number; readonly keptInit: Option.Option<string> };
}>;

const Encoder = Data.taggedEnum<Encoder>();

type InitSource = Data.TaggedEnum<{
  Kept: { readonly file: string };
  Run: { readonly run: Generation };
}>;

const InitSource = Data.taggedEnum<InitSource>();

/** A stream's use, and whether it still admits requests; no request gets in once a close began. */
interface Admission extends StreamLiveness.Use {
  readonly admitting: boolean;
}

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
  readonly mode: Ref.Ref<Exclude<PlaybackMode, "direct">>;
  readonly video: Ref.Ref<VideoPlan>;
  readonly audio: AudioPlan;
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

const isEncode = VideoPlan.$is("Encode");

const HARDWARE_MODES: Partial<Record<PlaybackMode, HardwareAcceleration.HardwareEncoder>> = {
  "transcode-qsv": "qsv",
  "transcode-vaapi": "vaapi",
};

const hardwareOf = (mode: PlaybackMode): HardwareAcceleration.HardwareEncoder | undefined =>
  HARDWARE_MODES[mode];

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
      : Effect.all([Scope.close(run.scope, Exit.void), Scope.close(run.readers, Exit.void)], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
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

const readerOf = <A, E>(generation: Generation, read: Effect.Effect<A, E>) =>
  read.pipe(
    Effect.forkIn(generation.readers),
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit): Effect.Effect<Option.Option<A>, E> =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.succeedNone
        : Effect.asSome(exit),
    ),
  );

const stopWaitingAfter =
  <L>(wait: Duration.Duration, late: () => L) =>
  <A, E, R>(request: Effect.Effect<A, E, R>) =>
    request.pipe(Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(late()) }));

const awaitStopped = (run: RunScope) =>
  Effect.interruptible(
    Deferred.await(run.stopped).pipe(Effect.timeoutOption(STOP_WAIT), Effect.asVoid),
  );

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tools = yield* MediaTools.Service;
  const keyframes = yield* KeyframeIndex.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const space = yield* TranscodeSpace.Service;
  const owners = yield* StreamOwners.Service;
  const reports = yield* SessionReports.Service;
  const sessions = yield* Ref.make<ReadonlyMap<StreamId, Session>>(new Map());
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
      stopped: yield* Deferred.make<void>(),
    };

    const opened = yield* Ref.modify(stream.runs, (runs) =>
      runs.sealed
        ? ([false, runs] as const)
        : ([true, { ...runs, live: new Map(runs.live).set(run.scope, run) }] as const),
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

  const onStreamFiber = <A, E>(session: Session, locked: Effect.Effect<A, E>) =>
    locked.pipe(
      Effect.forkIn(session.scope),
      Effect.flatMap(Fiber.await),
      Effect.flatMap((exit): Effect.Effect<A, E | StreamNotFound> =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.fail(new StreamNotFound({ streamId: session.streamId }))
          : exit,
      ),
    );

  const transition = <A, E>(session: Session, step: Effect.Effect<A, E>) =>
    onStreamFiber(session, session.lane.withPermits(1)(step));

  const transitionIfIdle = <A, E>(session: Session, step: Effect.Effect<A, E>) =>
    onStreamFiber(session, session.lane.withPermitsIfAvailable(1)(step));

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

    const args = hlsCommandArgs({
      input: session.file.path,
      sourceStart: session.file.probe.startSeconds,
      from,
      videoIndex: video?.index ?? 0,
      videoCodec: video?.codec ?? "",
      videoBitDepth: video?.bitDepth ?? 8,
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
      subtitleCodec:
        session.file.probe.subtitles.find((track) => track.index === session.burnSubtitle)?.codec ??
        "",
      outputDirectory: directory,
      qsvDevice: hardware.qsvDevice,
      vaapiDevice: hardware.vaapiDevice,
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
      Effect.try(() =>
        watchRenames(
          directory,
          (name) => FRAGMENT_FILE.test(name),
          wakeWaits,
          (cause) => {
            Effect.runForkWith(services)(watchFailed(cause));
          },
        ),
      ),
      (stop) => Effect.sync(stop),
    ).pipe(
      Effect.catch((error) => watchFailed(error.cause)),
      Scope.provide(scope),
    );

    const suspender = MutableRef.make<(paused: boolean) => Effect.Effect<void>>(() => Effect.void);

    const generation: Generation = {
      number,
      streamId: session.streamId,
      hardware: hardwareOf(yield* Ref.get(session.mode)) !== undefined,
      startSegment,
      from,
      directory,
      scope,
      readers: run.readers,
      exit,
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      wake,
      endUnknownLogged: MutableRef.make(false),
      videoTiming: MutableRef.make(Option.none<VideoTiming>()),
      suspend: (paused) => Effect.suspend(() => MutableRef.get(suspender)(paused)),
      paused: yield* Ref.make(false),
    };

    yield* Ref.set(session.requested, startSegment);
    const replaced = yield* Ref.getAndSet(session.generation, generation);

    if (number > 1 && replaced.number !== number) {
      yield* fs.remove(keptInitOf(session, replaced.number)).pipe(Effect.ignore);
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
      onSome: awaitStopped,
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
      tools.startFfmpeg(args).pipe(
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

  const fallBackToSoftware = Effect.fn("StreamSessions.fallBackToSoftware")(function* (
    session: Session,
  ) {
    const plan = decidePlayback(session.file.probe, session.client, {
      audioIndex: session.audioIndex,
      hardware: undefined,
      softwareToneMapping: yield* hardware.softwareToneMapping,
      quality: session.quality,
      burnSubtitle: session.burnSubtitle,
      copyVideo: false,
    });

    if (!PlaybackPlan.$is("Hls")(plan)) {
      return yield* new UnsupportedPlayback({
        reason: PlaybackPlan.$is("Unsupported")(plan)
          ? plan.reason
          : "hdr-tone-mapping-requires-hardware",
      });
    }

    const from = yield* Ref.getAndSet(session.mode, plan.mode);
    yield* Ref.set(session.video, plan.video);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChanged.make({
        sessionId: session.sessionId,
        userId: session.userId,
        fileId: session.fileId,
        streamId: session.streamId,
        from,
        to: plan.mode,
        reason: "hardware-unavailable",
      }),
    );

    return plan.mode;
  });

  const encoderFailed = Effect.fn("StreamSessions.encoderFailed")(function* (
    session: Session,
    generation: Generation,
    index: number,
    detail: string,
  ) {
    const restarted = yield* transition(
      session,
      Effect.gen(function* () {
        const current = yield* Ref.get(session.generation);

        if (current !== generation) return current;
        const encoder = yield* Ref.get(session.encoder);

        if (!Encoder.$is("Running")(encoder)) return yield* new SegmentNotReady({ index });

        const mode = yield* Ref.get(session.mode);

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
            detail,
          }),
        );

        const hardwareEncoder = hardwareOf(mode);

        if (hardwareEncoder === undefined) {
          return yield* new TranscodeFailed({ streamId: session.streamId, mode, detail });
        }

        yield* hardware.markUnavailable(hardwareEncoder, detail);
        yield* fallBackToSoftware(session);

        return yield* nextGeneration(session, encoder, generation.number + 1, index);
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
      if (isClosed(session.scope)) return yield* new StreamNotFound({ streamId: session.streamId });
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
      const refreshed = yield* readerOf(generation, refreshFragments(generation));
      const parsed = Option.getOrElse(refreshed, () => false);
      const fragments = yield* Ref.get(generation.fragments);
      const produced = producedRange(session, generation, fragments);
      const next = session.plan.starts[index + 1];

      const { followed, written } = reachOf(fragments, next);

      const readiness: Readiness =
        generation.hardware && index === generation.startSegment ? "followed" : "written";

      // A fragment that failed to parse this time may belong to the segment, so only an encoder
      // that started the next one proves the segment whole.
      const ready = readiness === "written" && parsed ? written : followed;

      if (finished) {
        const result = yield* Deferred.await(generation.exit).pipe(Effect.exit);

        if (Exit.isFailure(result) && !ready) {
          const detail = Exit.match(result, {
            onSuccess: () => "",
            onFailure: (cause) => String(cause),
          }).slice(-300);

          const neverServed = !(yield* Ref.get(session.served));

          return yield* encoderFailed(session, generation, index, detail).pipe(
            Effect.tapErrorTag("TranscodeFailed", () =>
              neverServed ? closeSession(session, "failed") : Effect.void,
            ),
          );
        }
      }

      if (finished || ready) {
        const members = produced.members.get(index) ?? [];

        // A planned start ffmpeg did not cut at: serve the fragment that covers it.
        const covering =
          members.length > 0
            ? members
            : fragments
                .filter((fragment) => fragment.start <= (session.plan.starts[index] ?? 0))
                .slice(-1);

        yield* Ref.set(session.served, true);

        return {
          paths: covering.map((fragment) => fragment.path),
          sizeBytes: covering.reduce((total, fragment) => total + fragment.sizeBytes, 0),
        } satisfies SegmentFiles;
      }

      const stopped = isClosed(generation.scope);

      if (stopped || (yield* Clock.currentTimeMillis) > deadline) {
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
    yield* readerOf(generation, refreshFragments(generation));
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

  const using = <A, E>(
    streamId: StreamId,
    grant: PlaybackGrant,
    notReady: (session: Session) => number,
    f: (session: Session) => Effect.Effect<A, E>,
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

    for (let attempt = 0; attempt < 2; attempt += 1) {
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

    yield* Effect.annotateCurrentSpan({ mode: yield* Ref.get(session.mode) });

    return generation;
  });

  const claimRun = (
    stream: Lifecycle,
    transcoding: boolean,
    audience: EncoderSlots.Audience,
    claimant: EncoderSlots.Claimant,
    wait: Duration.Duration,
  ): Effect.Effect<Run, TranscodeCapacityReached | StreamNotFound> => {
    const pool = transcoding ? transcodes : copies;

    return openRun(stream).pipe(
      Effect.flatMap((opened) =>
        (audience === "household"
          ? pool.household(opened.scope, claimant)
          : pool.guest(opened.scope, claimant).pipe(
              stopWaitingAfter(wait, () => new TranscodeCapacityReached({ limit: pool.limit })),
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
  ) {
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

    // The player holds this generation's init segment from the lost encoder, and software segments
    // do not decode under it, so a fallback moves to the next generation. When software cannot
    // play the file at all, the negotiation the player falls back to says why.
    const started = yield* Effect.gen(function* () {
      const used = hardwareOf(yield* Ref.get(session.mode));
      const lost = used !== undefined && used !== (yield* hardware.encoder);

      if (lost) yield* fallBackToSoftware(session);

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
    return yield* transition(
      session,
      Effect.gen(function* () {
        const encoder = yield* Ref.get(session.encoder);

        if (Encoder.$is("Released")(encoder)) return yield* revive(session, encoder, index);
        const current = yield* Ref.get(session.generation);
        yield* readerOf(current, refreshFragments(current));
        const produced = producedRange(session, current, yield* Ref.get(current.fragments));

        if (index >= current.startSegment && index <= produced.head + LOOKAHEAD_SEGMENTS)
          return current;

        return yield* nextGeneration(session, encoder, current.number + 1, index);
      }),
    );
  });

  const keepInit = Effect.fnUntraced(function* (session: Session, run: Generation) {
    const kept = keptInitOf(session, run.number);

    if (yield* fs.exists(kept).pipe(Effect.orElseSucceed(() => false))) return Option.some(kept);
    yield* refreshFragments(run);

    const temporary = `${kept}.tmp`;

    // ffmpeg's HLS muxer finishes `init.mp4` only when it writes the first fragment. The bytes are
    // written here rather than with `copyFile`, whose libuv implementation calls `fchown`: the
    // NixOS unit's system call filter denies it, which once killed the service and every stream.
    const copied =
      (yield* Ref.get(run.fragments)).length > 0 &&
      (yield* fs.readFile(path.join(run.directory, "init.mp4")).pipe(
        Effect.andThen((bytes) => fs.writeFile(temporary, bytes)),
        Effect.andThen(fs.rename(temporary, kept)),
        Effect.as(true),
        Effect.catch(() => fs.remove(temporary).pipe(Effect.ignore, Effect.as(false))),
      ));

    return copied ? Option.some(kept) : Option.none();
  });

  const keepInitWithin = (session: Session, run: Generation) =>
    readerOf(run, keepInit(session, run)).pipe(
      Effect.map(Option.flatten),
      Effect.timeoutOption(KEEP_INIT_WAIT),
      Effect.map(Option.flatten),
    );

  const stopEncoder = Effect.fnUntraced(function* (
    session: Session,
    run: Run,
    keptInit: Option.Option<string>,
  ) {
    yield* Ref.set(
      session.encoder,
      Encoder.Released({ since: yield* Clock.currentTimeMillis, keptInit }),
    );
    yield* beginStop(session, run);
    yield* awaitStopped(run);
  });

  const yieldEncoder = Effect.fn("StreamSessions.yieldEncoder")(function* (
    session: Session,
    run: Run,
  ) {
    yield* transition(
      session,
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
    yield* transitionIfIdle(
      session,
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
      directory: path.join(config.transcodeDir, streamId),
      torndown: yield* Deferred.make<void>(),
    };

    const registered = yield* Ref.make(Option.none<Session>());
    const limit = (isEncode(request.plan.video) ? transcodes : copies).limit;

    return yield* startIn(stream, registered, grant, ticket, request).pipe(
      stopWaitingAfter(startWait, () => new TranscodeCapacityReached({ limit })),
      Effect.onExit((exit) =>
        Ref.get(registered).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => (Exit.isSuccess(exit) ? Effect.void : teardown(stream)),
              onSome: (session) =>
                Exit.isSuccess(exit)
                  ? leave(session)
                  : closeSession(session, Exit.hasInterrupts(exit) ? "abandoned" : "failed"),
            }),
          ),
        ),
      ),
    );
  });

  const startIn = Effect.fnUntraced(function* (
    stream: Lifecycle,
    registered: Ref.Ref<Option.Option<Session>>,
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
    );

    const placeholder: Generation = {
      number: 0,
      streamId,
      hardware: false,
      startSegment: 0,
      from: segmentPlan.starts[0] ?? segmentPlan.end,
      directory: "",
      scope: run.scope,
      readers: run.readers,
      exit: yield* Deferred.make<void, MediaTools.MediaToolFailed>(),
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      wake: MutableRef.make(Deferred.makeUnsafe<void>()),
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
      mode: yield* Ref.make(plan.mode),
      video: yield* Ref.make(plan.video),
      audio: plan.audio,
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

    const first = yield* transition(
      session,
      startGeneration(session, run, Option.none(), 1, segmentIndex),
    );

    if (Option.isNone(first)) return yield* refused();

    const generation =
      hardwareOf(plan.mode) !== undefined
        ? yield* firstSegment(session, first.value, segmentIndex)
        : first.value;

    const mode = yield* Ref.get(session.mode);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
        sessionId: grant.sessionId,
        userId: grant.userId,
        fileId: grant.fileId,
        streamId,
        mode,
      }),
    );

    return { streamId, generation: generation.number, mode, segmentIndex } satisfies StartedStream;
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
    return yield* transition(
      session,
      Effect.gen(function* () {
        const current = yield* currentGeneration(session, generation);
        const encoder = yield* Ref.get(session.encoder);

        if (Encoder.$is("Running")(encoder)) return InitSource.Run({ run: current });

        if (Option.isSome(encoder.keptInit)) {
          return InitSource.Kept({ file: encoder.keptInit.value });
        }

        yield* revive(session, encoder, yield* Ref.get(session.requested));

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
        const initPath = yield* InitSource.$match(yield* initSource(session, generation), {
          Kept: ({ file }) => Effect.succeed(file),
          Run: ({ run }) =>
            awaitSegment(session, run, run.startSegment, SEGMENT_WAIT).pipe(
              Effect.as(path.join(run.directory, "init.mp4")),
            ),
        });

        const info = yield* fs
          .stat(initPath)
          .pipe(
            Effect.catch(() =>
              currentGeneration(session, generation).pipe(
                Effect.andThen(Effect.fail(new SegmentNotReady({ index: -1 }))),
              ),
            ),
          );

        return { paths: [initPath], sizeBytes: Number(info.size) } satisfies SegmentFiles;
      }),
    );
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

          return yield* awaitSegment(session, covering, index, SEGMENT_WAIT);
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

        return { streamId, generation: covering.number, plan: session.plan } satisfies StreamView;
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
    Effect.gen(function* () {
      for (const session of (yield* Ref.get(sessions)).values())
        yield* closeSession(session, "shutdown");
    }),
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
    runsAwaitingExit: Ref.get(sessions).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (session) =>
          Ref.get(session.runs).pipe(Effect.map(({ live }) => live.size)),
        ),
      ),
      Effect.map((counts) => counts.reduce((total, count) => total + count, 0)),
    ),
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
  | HardwareAcceleration.Service
  | PlaybackReporter.Service
  | TranscodeSpace.Service
  | StreamOwners.Service
  | SessionReports.Service
> = Layer.effect(Service, make);
