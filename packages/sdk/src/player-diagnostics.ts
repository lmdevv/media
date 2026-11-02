import {
  AudioRendition,
  type ClientDiagnosticEvent,
  ClientDiagnosticsRequest,
  type ClientPlatform,
  DIAGNOSTICS_ROUTES,
  MAX_CLIENT_EVENTS,
  PlayerObservation,
  type PlayerEngine,
  type RecoveryAction,
  type StartupStages,
} from "@movies/contracts/diagnostics";
import type { PlaybackSessionId } from "@movies/contracts/ids";
import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";

import { encodeJson, mediaUrl, requestPlayback } from "./media-http";
import type { Playback } from "./playback";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";

const MAX_REASON_LENGTH = 120;

/** A recovery the player took after a failure `reason` describes, cut to what the service takes. */
export const recovery = (action: RecoveryAction, reason: string): PlayerObservation =>
  PlayerObservation.cases.Recovery.make({ action, reason: reason.slice(0, MAX_REASON_LENGTH) });

const decodeRendition = Schema.decodeOption(AudioRendition);

const renditionDroppingBadLanguage = (
  codec: string,
  channels: number,
  language: string | null | undefined,
): Option.Option<AudioRendition> =>
  Option.orElse(
    Option.flatMap(Option.fromNullishOr(language), (tag) =>
      decodeRendition({ codec, channels, language: tag }),
    ),
    () => decodeRendition({ codec, channels }),
  );

const audioOf = ({ started, stream }: Playback): Option.Option<AudioRendition> =>
  Option.flatMap(Option.fromNullishOr(stream.audio), ({ streamIndex, codec, channels }) =>
    renditionDroppingBadLanguage(
      codec,
      channels,
      started.file.probe.audio.find((each) => each.index === streamIndex)?.language,
    ),
  );

/** The stream of `playback` attached to a player of `engine`, with the audio rendition it plays. */
export const attached = (playback: Playback, engine: PlayerEngine): PlayerObservation =>
  PlayerObservation.cases.Attached.make({
    mode: playback.stream.mode,
    engine,
    ...Option.match(audioOf(playback), { onNone: () => ({}), onSome: (audio) => ({ audio }) }),
  });

const tokenRenewal = (before: Playback, now: number): PlayerObservation => {
  const seconds = Math.round((before.started.tokenExpiresAt - now) / 1000);

  return recovery(
    "renew-token",
    seconds >= 0
      ? `Renewed the playback token ${String(seconds)} s before it expired`
      : `Renewed the playback token ${String(-seconds)} s after it expired`,
  );
};

/**
 * A point a player reaches on the way from the viewer's play intent to the first frame. Each
 * player reports the stages it can see.
 */
export type StartupStage = "negotiated" | "manifestLoaded" | "firstFragmentLoaded" | "firstFrame";

const STAGE_FIELDS = {
  negotiated: "negotiatedMs",
  manifestLoaded: "manifestLoadedMs",
  firstFragmentLoaded: "firstFragmentMs",
  firstFrame: "firstFrameMs",
} as const satisfies Record<StartupStage, keyof StartupStages>;

interface StartupTrace {
  readonly intentAt: number;
  readonly reached: ReadonlyMap<StartupStage, number>;
  /** A startup already went out with these stages; a later one of the intent gets none. */
  readonly reported: boolean;
}

const stagesOf = ({ intentAt, reached }: StartupTrace): StartupStages => {
  const stages: { -readonly [Field in keyof StartupStages]: StartupStages[Field] } = {};

  for (const [stage, at] of reached) {
    stages[STAGE_FIELDS[stage]] = Math.max(0, Math.round(at - intentAt));
  }

  return stages;
};

/** Records what a player saw. */
export interface Recorder {
  /**
   * Notes `observation` as happening now, in the stream playing now; it goes out with the next
   * batch. Never blocks or fails.
   */
  readonly record: (observation: PlayerObservation) => void;
  /**
   * The viewer asked to play at `at` (now by default). The next startup reports its stages from
   * here; an earlier intent's stages are dropped.
   */
  readonly intent: (at?: number) => void;
  /** The player reached `stage` now; only the first time after the latest intent counts. */
  readonly reached: (stage: StartupStage) => void;
  /** The latest play intent, until the session it started first plays. */
  readonly intentAt: () => Option.Option<number>;
  /**
   * The service renewed `before`'s stream as `after` now. Another token in the same session goes
   * out as a `renew-token` recovery with `after`'s token; anything else is not a renewal.
   */
  readonly tokenRenewed: (before: Playback, after: Playback) => void;
  /**
   * Ends a startup or stall in progress as `closed` and samples dropped frames one last time,
   * reading the player now, so a caller can release the player right after. The player is never
   * read again; closing the scope sends what is queued. Closing twice does nothing more.
   */
  readonly close: () => void;
}

/** Frames the decoder has dropped and decoded since the element or player was created. */
export interface FrameCounts {
  readonly dropped: number;
  readonly decoded: number;
}

/** Where the recorder sends events and what it samples on its own. */
export interface Options {
  readonly platform: ClientPlatform;
  /**
   * The playback playing now, if one does. An event goes out with the token of the playback that
   * played when it happened, or else the last one that played: a token stays good for its
   * session's last events once the session ended.
   */
  readonly playback: () => Option.Option<Playback>;
  /** Seconds the player holds ahead of its position. */
  readonly bufferedAheadSeconds: () => number;
  /** The decoder's frame counts, where the platform reports them. */
  readonly frames: () => Option.Option<FrameCounts>;
}

const FLUSH_INTERVAL = Duration.seconds(5);

const FINAL_FLUSH_TIMEOUT = Duration.seconds(2);

const MAX_PENDING = 500;

const MAX_AGE_MS = 600_000;

interface Pending {
  readonly observation: PlayerObservation;
  readonly at: number;
  readonly playback: Playback;
}

interface Wait {
  readonly kind: "startup" | "stall";
  readonly since: number;
}

type WaitEndedBy = Extract<PlayerObservation, { readonly _tag: "StartupEnded" }>["endedBy"];

interface EndedStartup {
  readonly positionSeconds: number;
  readonly durationMs: number;
  readonly endedBy: WaitEndedBy;
  readonly at: number;
  readonly playback: Playback;
}

interface FragmentLoads {
  readonly sessionId: PlaybackSessionId;
  readonly count: number;
}

const toEvents = (
  pending: ReadonlyArray<Pending>,
  now: number,
): ReadonlyArray<ClientDiagnosticEvent> =>
  pending.flatMap(({ observation, at, playback }): ReadonlyArray<ClientDiagnosticEvent> => {
    const ageMs = Math.max(0, Math.round(now - at));

    if (ageMs > MAX_AGE_MS) return [];

    return [
      Option.match(Option.fromNullishOr(playback.stream.streamId), {
        onNone: () => ({ ageMs, observation }),
        onSome: (id) => ({ ageMs, streamId: id, observation }),
      }),
    ];
  });

const batches = <A>(events: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(events.length / MAX_CLIENT_EVENTS) }, (_, index) =>
    events.slice(index * MAX_CLIENT_EVENTS, (index + 1) * MAX_CLIENT_EVENTS),
  );

const send = (
  playback: Playback,
  platform: ClientPlatform,
  events: ReadonlyArray<ClientDiagnosticEvent>,
): Effect.Effect<void> =>
  Effect.forEach(
    batches(events),
    (batch) =>
      encodeJson(ClientDiagnosticsRequest, {
        token: Redacted.make(playback.started.token),
        platform,
        events: batch,
      }).pipe(
        Effect.flatMap((body) =>
          Effect.flatMap(mediaUrl(playback.started, DIAGNOSTICS_ROUTES.clientEvents), (url) =>
            requestPlayback(
              {
                operation: "playback.diagnostics",
                url,
                method: "POST",
                body: Option.some(body),
                bearer: Option.none(),
              },
              Schema.Null,
            ),
          ),
        ),
        Effect.catch((error) => Effect.logDebug("PlayerDiagnostics.dropped", error)),
      ),
    { discard: true },
  );

/**
 * Records how long each of `player`'s playback sessions takes to start, its stalls after that, and
 * the platform's own events until the scope closes, sending them in batches with the playback
 * `options.playback` names.
 */
export const reportDiagnostics = Effect.fn("PlayerDiagnostics.report")(function* (
  player: PlayerPort,
  options: Options,
): Effect.fn.Return<Recorder, never, Scope.Scope> {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.sliding<Pending>(MAX_PENDING);
  const oneBatchAtATime = yield* Semaphore.make(1);

  const state = {
    waiting: Option.none<Wait>(),
    lastPlayback: Option.none<Playback>(),
    played: Option.none<PlaybackSessionId>(),
    counted: { dropped: 0, decoded: 0 } satisfies FrameCounts,
    trace: Option.none<StartupTrace>(),
    held: Option.none<EndedStartup>(),
    fragments: Option.none<FragmentLoads>(),
    closed: false,
  };

  const playbackNow = (): Option.Option<Playback> =>
    Option.orElse(options.playback(), () => state.lastPlayback);

  const resolvePlayback = (): Option.Option<Playback> => {
    const playback = playbackNow();

    state.lastPlayback = playback;

    return playback;
  };

  const numbered = (observation: PlayerObservation, playback: Playback): PlayerObservation => {
    const { sessionId } = playback.started;

    if (
      !Predicate.isTagged(observation, "FragmentLoaded") ||
      Option.contains(state.played, sessionId)
    ) {
      return observation;
    }

    const index = Option.match(state.fragments, {
      onNone: () => 0,
      onSome: (loads) => (loads.sessionId === sessionId ? loads.count : 0),
    });

    state.fragments = Option.some({ sessionId, count: index + 1 });

    return observation.index === undefined
      ? PlayerObservation.cases.FragmentLoaded.make({ ...observation, index })
      : observation;
  };

  const note = (observation: PlayerObservation): void => {
    const playback = resolvePlayback();

    if (Option.isNone(playback)) return;
    Queue.offerUnsafe(queue, {
      observation: numbered(observation, playback.value),
      at: clock.currentTimeMillisUnsafe(),
      playback: playback.value,
    });
  };

  const sendStartup = ({ at, playback, ...ended }: EndedStartup): void => {
    Queue.offerUnsafe(queue, {
      observation: PlayerObservation.cases.StartupEnded.make({
        ...ended,
        ...Option.match(
          Option.filter(state.trace, (trace) => !trace.reported),
          { onNone: () => ({}), onSome: (trace) => ({ stages: stagesOf(trace) }) },
        ),
      }),
      at,
      playback,
    });

    state.trace = Option.map(state.trace, (trace) => ({ ...trace, reported: true }));
  };

  const releaseHeld = (): void => {
    const held = state.held;

    state.held = Option.none();

    if (Option.isSome(held)) sendStartup(held.value);
  };

  const endStartup = (ended: Omit<EndedStartup, "at" | "playback">): void => {
    const playback = resolvePlayback();

    if (Option.isNone(playback)) return;
    const startup = { ...ended, at: clock.currentTimeMillisUnsafe(), playback: playback.value };

    // A player can say it plays before it shows a frame, so the first frame may still come.
    const framePending = Option.exists(state.trace, (trace) => !trace.reached.has("firstFrame"));

    if (ended.endedBy === "playing" && framePending) state.held = Option.some(startup);
    else sendStartup(startup);
  };

  const intent = (at: number = clock.currentTimeMillisUnsafe()): void => {
    if (state.closed) return;
    releaseHeld();
    state.trace = Option.some({ intentAt: at, reached: new Map(), reported: false });
  };

  const reached = (stage: StartupStage): void => {
    if (state.closed || Option.isNone(state.trace) || state.trace.value.reached.has(stage)) return;
    const trace = state.trace.value;

    state.trace = Option.some({
      ...trace,
      reached: new Map(trace.reached).set(stage, clock.currentTimeMillisUnsafe()),
    });

    if (stage === "firstFrame") releaseHeld();
  };

  const intentAt = (): Option.Option<number> => Option.map(state.trace, (trace) => trace.intentAt);

  const tokenRenewed = (before: Playback, after: Playback): void => {
    if (
      after.started.sessionId !== before.started.sessionId ||
      after.started.token === before.started.token
    ) {
      return;
    }

    const at = clock.currentTimeMillisUnsafe();

    Queue.offerUnsafe(queue, { observation: tokenRenewal(before, at), at, playback: after });
  };

  const positionSeconds = () => Math.max(0, player.positionMs() / 1000);

  const where = () => ({
    positionSeconds: positionSeconds(),
    bufferedAheadSeconds: Math.max(0, options.bufferedAheadSeconds()),
  });

  const startWait = (): void => {
    const session = Option.map(playbackNow(), (playback) => playback.started.sessionId);

    const kind = Option.exists(session, (id) => Option.contains(state.played, id))
      ? "stall"
      : "startup";

    state.waiting = Option.some({ kind, since: clock.currentTimeMillisUnsafe() });

    if (kind === "stall") note(PlayerObservation.cases.BufferingStarted.make(where()));
  };

  const endWait = (endedBy: WaitEndedBy): void => {
    if (Option.isNone(state.waiting)) return;
    const { kind, since } = state.waiting.value;
    const durationMs = Math.max(0, Math.round(clock.currentTimeMillisUnsafe() - since));

    state.waiting = Option.none();

    if (kind === "stall") {
      note(PlayerObservation.cases.BufferingEnded.make({ ...where(), durationMs, endedBy }));
    } else {
      endStartup({ positionSeconds: positionSeconds(), durationMs, endedBy });
    }
  };

  const onPlayerEvent = (event: PlayerEvent): void => {
    if (state.closed) return;

    if (event === "waiting" && Option.isNone(state.waiting) && !player.isPaused()) {
      startWait();
    } else if (event === "playing") {
      endWait(event);
      state.played = Option.map(playbackNow(), (playback) => playback.started.sessionId);

      if (Option.isNone(state.held)) state.trace = Option.none();
    } else if (event === "paused") {
      endWait(event);
    }
  };

  const sampleFrames = (): void => {
    if (state.closed) return;
    const counts = options.frames();

    if (Option.isNone(counts)) return;
    const dropped = counts.value.dropped - state.counted.dropped;
    const decoded = counts.value.decoded - state.counted.decoded;

    state.counted = counts.value;

    if (dropped > 0 && decoded >= 0)
      note(PlayerObservation.cases.DroppedFrames.make({ dropped, decoded }));
  };

  const close = (): void => {
    if (state.closed) return;
    endWait("closed");
    releaseHeld();
    sampleFrames();
    state.closed = true;
  };

  const releaseOverdue = (): void => {
    const now = clock.currentTimeMillisUnsafe();

    if (Option.exists(state.held, ({ at }) => now - at >= Duration.toMillis(FLUSH_INTERVAL))) {
      releaseHeld();
    }
  };

  const flush = oneBatchAtATime.withPermits(1)(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        releaseOverdue();
        sampleFrames();
      });
      const pending = yield* Queue.clear(queue);
      const now = yield* Clock.currentTimeMillis;
      const byToken = Arr.groupBy(pending, (each) => each.playback.started.token);

      yield* Effect.forEach(
        Object.values(byToken),
        (group) => send(group[0].playback, options.platform, toEvents(group, now)),
        { discard: true },
      );
    }),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() => player.subscribe(onPlayerEvent)),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Effect.forkScoped(Effect.repeat(Effect.delay(flush, FLUSH_INTERVAL), Schedule.forever));
  yield* Effect.addFinalizer(() =>
    Effect.sync(close).pipe(
      Effect.andThen(flush),
      Effect.timeout(FINAL_FLUSH_TIMEOUT),
      Effect.ignore,
    ),
  );

  return { record: note, intent, reached, intentAt, tokenRenewed, close } satisfies Recorder;
});
