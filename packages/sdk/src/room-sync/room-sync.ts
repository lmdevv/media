import type { ClockOffset, ClockSample } from "@media/contracts/clock";
import type { CommandArgs } from "@media/contracts/commands";
import {
  countdownRemaining,
  estimateClockOffset,
  isNewerRevision,
  targetPosition,
  toServerTime,
} from "@media/contracts/clock";
import type { DeviceId, MediaFileId, RoomId } from "@media/contracts/ids";
import type { Room, RoomClock } from "@media/contracts/models/rooms";
import type { EpochMillis } from "@media/contracts/units";
import { EpochMillis as EpochMillisSchema, Milliseconds } from "@media/contracts/units";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";
import type { PlayerEvent, PlayerPort } from "./player-port";
import { playerEvents } from "./player-port";
import { readServerClock } from "./server-clock";
import type { HostCommand, PlayerSnapshot, RoomSyncTunables } from "./sync-policy";
import { commandLabel, follow, hostIntent, PlayerCommand } from "./sync-policy";

/** This device's part in the room. */
export type RoomRole = "host" | "guest";

/**
 * How this device follows the room. `buffering`: stalled, catching up when it plays again.
 * `detached`: the guest paused their own player; following resumes when they play. `blocked`:
 * the platform refused to start playback until the user interacts. `moved`: the room plays another
 * file now (the next episode, or the host's pick), so this player is left alone and never moves
 * the room's clock until the app opens the new media with a new engine. `ended`: the room is over.
 */
export type FollowState = "following" | "buffering" | "detached" | "blocked" | "moved" | "ended";

/** Where the engine stands, for the UI. */
export interface RoomSyncState {
  readonly role: RoomRole;
  /** The newest room snapshot: members, title, and presence. */
  readonly room: Room;
  /** The newest committed clock applied; it can be newer than `room.clock`. */
  readonly clock: RoomClock;
  /** `reconnecting` after a heartbeat went unanswered, until the room has been read again. */
  readonly connection: "connected" | "reconnecting";
  readonly follow: FollowState;
  /** Server time minus device time, once estimated. */
  readonly offset: ClockOffset | null;
  /** The last measured distance from the shared position; positive means ahead. */
  readonly driftMs: number | null;
}

/** Whether a host may use its controls now: connected, synchronized, and the room still open. */
export const hostControlsEnabled = (state: RoomSyncState): boolean =>
  state.role === "host" &&
  state.connection === "connected" &&
  state.offset !== null &&
  state.follow !== "moved" &&
  state.clock.status !== "ended";

/**
 * How long is left on the room's next-episode countdown at `deviceNow`, by the server's clock as
 * this device estimates it (its own clock until the offset is known), or null while none runs.
 * Every member computes it from the same `nextAt`, so they all count down together, and a member
 * who reloads mid-countdown picks it up where the others are.
 */
export const nextEpisodeCountdownMs = (
  state: Pick<RoomSyncState, "room" | "offset">,
  deviceNow: number,
): Milliseconds | null => {
  const { next } = state.room;

  if (next?.status !== "pending") return null;

  const serverNow =
    state.offset === null
      ? EpochMillisSchema.make(deviceNow)
      : toServerTime(deviceNow, state.offset);

  return countdownRemaining(next.nextAt, serverNow);
};

/** What to synchronize. */
export interface RoomSyncOptions {
  readonly roomId: RoomId;
  /** This device; it is the host when it matches the room's host device. */
  readonly deviceId: DeviceId;
  readonly player: PlayerPort;
  readonly tunables: RoomSyncTunables;
  /**
   * The file `player` plays; the room's when the engine starts, by default. Once the room plays
   * another, the engine stops following and commanding (`moved`).
   */
  readonly fileId?: MediaFileId | undefined;
}

/** A running engine. It stops when its scope closes. */
export interface RoomSync {
  /** The current state, then every change. */
  readonly state: Stream.Stream<RoomSyncState>;
  /** The state now. */
  readonly current: Effect.Effect<RoomSyncState>;
}

class PlaybackBlocked extends Schema.TaggedError<PlaybackBlocked>()("PlaybackBlocked", {
  cause: Schema.Defect(),
}) {}

/**
 * Starts synchronizing `options.player` with the room. Reads the room and the server clock first,
 * so a late joiner seeks straight to the live position; fails when the room cannot be read.
 */
export const run = Effect.fn("RoomSync.run")(function* (options: RoomSyncOptions) {
  const client = yield* MoviesClient;
  const { player, tunables, roomId, deviceId } = options;
  const initial = yield* client.query("rooms.get", { roomId });
  const fileId = options.fileId ?? initial.fileId;
  const role: RoomRole = initial.hostDeviceId === deviceId ? "host" : "guest";
  const window = Math.max(1, tunables.offsetSamples * 2);
  const samples = yield* Ref.make<ReadonlyArray<ClockSample>>([]);
  const lastSeekAt = yield* Ref.make(Option.none<number>());
  const settledOn = yield* Ref.make<number | null>(null);
  const pauseEchoes = yield* Ref.make(0);
  const catchingUpSince = yield* Ref.make(Option.none<number>());
  const catchUpSeeks = yield* Ref.make<ReadonlyArray<number>>([]);
  const catchUpNudged = yield* Ref.make(false);
  const serial = yield* Semaphore.make(1);

  const state = yield* SubscriptionRef.make<RoomSyncState>({
    role,
    room: initial,
    clock: initial.clock,
    connection: "connected",
    follow:
      initial.clock.status === "ended"
        ? "ended"
        : initial.fileId === fileId
          ? "following"
          : "moved",
    offset: null,
    driftMs: null,
  });

  const update = (f: (current: RoomSyncState) => RoomSyncState): Effect.Effect<void> =>
    SubscriptionRef.update(state, f);

  const addSamples = Effect.fn("RoomSync.addSamples")(function* () {
    const fresh = yield* readServerClock(tunables.offsetSamples, tunables.offsetSampleSpacingMs);
    const kept = yield* Ref.updateAndGet(samples, (old) => [...old, ...fresh].slice(-window));
    const offset = estimateClockOffset(kept) ?? null;

    yield* update((current) => ({ ...current, offset }));
  });

  const serverNow: Effect.Effect<Option.Option<EpochMillis>> = Effect.gen(function* () {
    const { offset } = yield* SubscriptionRef.get(state);

    if (offset === null) return Option.none();
    const now = yield* Clock.currentTimeMillis;

    return Option.some(toServerTime(now, offset));
  });

  const snapshot = (): PlayerSnapshot => ({
    positionMs: player.positionMs(),
    paused: player.isPaused(),
    buffering: player.isBuffering(),
    playbackRate: player.playbackRate(),
    fixedRate: player.fixedRate === true,
  });

  const execute = (command: PlayerCommand): Effect.Effect<void> =>
    PlayerCommand.$match(command, {
      Seek: ({ positionMs }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          if (Option.isSome(yield* Ref.get(catchingUpSince))) {
            yield* Ref.update(catchUpSeeks, (targets) => [...targets, positionMs]);
          }

          yield* Ref.set(lastSeekAt, Option.some(now));
          player.seek(positionMs);
        }),
      Pause: () =>
        Effect.gen(function* () {
          yield* Ref.update(pauseEchoes, (count) => count + 1);
          player.pause();
        }),
      SetRate: ({ rate }) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* Ref.get(catchingUpSince))) yield* Ref.set(catchUpNudged, true);
          player.setPlaybackRate(rate);
        }),
      Play: () =>
        Effect.tryPromise({
          try: () => player.play(),
          catch: (cause) => new PlaybackBlocked({ cause }),
        }).pipe(
          Effect.catchTag("PlaybackBlocked", () =>
            Effect.gen(function* () {
              yield* Effect.logInfo("RoomSync.playBlocked");
              yield* update((current) => ({ ...current, follow: "blocked" }));
            }),
          ),
        ),
    });

  const align = Effect.fn("RoomSync.align")(function* () {
    const current = yield* SubscriptionRef.get(state);
    const now = yield* serverNow;

    if (Option.isNone(now)) return;
    const clientNow = yield* Clock.currentTimeMillis;

    const recentlySought = Option.match(yield* Ref.get(lastSeekAt), {
      onNone: () => false,
      onSome: (at) => clientNow - at < tunables.seekCooldownMs,
    });

    const decision = follow(
      current.clock,
      now.value,
      snapshot(),
      recentlySought,
      (yield* Ref.get(settledOn)) !== current.clock.revision,
      tunables,
    );

    yield* Ref.set(settledOn, decision.settling ? null : current.clock.revision);
    yield* update((latest) => ({ ...latest, driftMs: decision.driftMs }));

    if (decision.commands.length > 0) {
      yield* Effect.logDebug("RoomSync.correct").pipe(
        Effect.annotateLogs({
          roomId,
          revision: current.clock.revision,
          driftMs: decision.driftMs ?? "buffering",
          commands: decision.commands.map(commandLabel).join(","),
        }),
      );
    }

    yield* Effect.forEach(decision.commands, execute, { discard: true });
  });

  const endCatchUp = Effect.gen(function* () {
    yield* Ref.set(catchingUpSince, Option.none<number>());
    yield* Ref.set(catchUpSeeks, []);
    const { clock } = yield* SubscriptionRef.get(state);

    if (yield* Ref.getAndSet(catchUpNudged, false)) player.setPlaybackRate(clock.playbackRate);
  });

  const isCatchingUp: Effect.Effect<boolean> = Effect.gen(function* () {
    const since = yield* Ref.get(catchingUpSince);

    if (Option.isNone(since)) return false;

    return (yield* Clock.currentTimeMillis) - since.value < tunables.hostCatchUpMs;
  });

  const settleExpiredCatchUp = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(catchingUpSince))) yield* endCatchUp;
  });

  const catchUp = Effect.fn("RoomSync.catchUp")(function* (current: RoomSyncState) {
    if (Option.isNone(yield* Ref.get(catchingUpSince))) return;

    if (current.clock.status !== "playing") {
      yield* endCatchUp;
      yield* align();

      return;
    }

    if (!(yield* isCatchingUp)) {
      yield* endCatchUp;
      yield* publishNow(false);

      return;
    }

    yield* align();
    const { driftMs, follow: following } = yield* SubscriptionRef.get(state);
    const settled = (yield* Ref.get(settledOn)) === current.clock.revision;

    if (following === "blocked") {
      yield* update((latest) => ({ ...latest, follow: "following" }));
      yield* endCatchUp;
      yield* publishNow(false);

      return;
    }

    if (settled && driftMs !== null && Math.abs(driftMs) <= tunables.inSyncMs) {
      yield* endCatchUp;
      yield* publishNow(false);
    }
  });

  const correct = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.follow === "moved") return;

      if (current.role === "host") {
        yield* catchUp(current);

        return;
      }

      if (current.follow === "ended") return;

      const following = current.follow === "following" || current.follow === "buffering";

      if (!following && current.clock.status === "playing") return;

      yield* align();
    }),
  );

  const applyClock = (clock: RoomClock): Effect.Effect<boolean> =>
    SubscriptionRef.modify(state, (current) => {
      if (current.follow === "moved" || !isNewerRevision(clock, current.clock)) {
        return [false, current];
      }

      const followState: FollowState =
        clock.status === "ended"
          ? "ended"
          : current.follow === "detached" && clock.status !== "playing"
            ? "following"
            : current.follow;

      return [true, { ...current, clock, follow: followState }];
    });

  const adopt = (room: Room): Effect.Effect<boolean> =>
    room.fileId === fileId
      ? Effect.andThen(
          update((current) => ({
            ...current,
            room,
            follow: current.follow === "moved" ? "following" : current.follow,
          })),
          applyClock(room.clock),
        )
      : Effect.as(
          update((current) => ({
            ...current,
            room,
            follow: current.follow === "ended" ? "ended" : "moved",
          })),
          false,
        );

  const resync = serial.withPermits(1)(
    Effect.gen(function* () {
      const room = yield* client.query("rooms.get", { roomId });

      yield* adopt(room);

      if (room.fileId === fileId) yield* align();
    }),
  );

  const markReconnecting = update((current) => ({ ...current, connection: "reconnecting" }));

  const sendHostCommand = Effect.fn("RoomSync.hostCommand")(function* (
    intent: HostCommand,
    revision: number,
  ) {
    const result = yield* client.mutate(intent.command, {
      roomId,
      deviceId,
      revision,
      positionMs: intent.positionMs,
      fileId,
    });

    yield* applyClock(result);
  });

  function publishNow(seeked: boolean): Effect.Effect<void> {
    return Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.role !== "host" || current.connection !== "connected") return;

      if (current.follow === "moved") return;

      if (yield* isCatchingUp) return;
      yield* settleExpiredCatchUp;
      const now = yield* serverNow;

      if (Option.isNone(now)) return;
      const intent = hostIntent(current.clock, now.value, snapshot(), seeked, tunables);

      if (Option.isNone(intent)) return;

      yield* sendHostCommand(intent.value, current.clock.revision).pipe(
        Effect.catchTag("TransportError", () => markReconnecting),
        Effect.catch((error: CallError) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("RoomSync.hostCommandRejected", error).pipe(
              Effect.annotateLogs({ roomId, command: intent.value.command }),
            );

            const room = yield* client.query("rooms.get", { roomId });

            yield* adopt(room);

            if (room.fileId === fileId) yield* align();
          }).pipe(Effect.catch(() => markReconnecting)),
        ),
      );
    });
  }

  const publish = (seeked: boolean): Effect.Effect<void> =>
    serial.withPermits(1)(publishNow(seeked));

  const joinLiveClock = serial.withPermits(1)(
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);
      const now = yield* serverNow;

      if (clock.status !== "playing") return;

      if (
        Option.isSome(now) &&
        Math.abs(player.positionMs() - targetPosition(clock, now.value)) <= tunables.hostSeekMs
      ) {
        return;
      }

      yield* Ref.set(catchingUpSince, Option.some(yield* Clock.currentTimeMillis));
      yield* align();
    }),
  );

  const onPlayerEvent = (event: PlayerEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if (current.follow === "moved") return;

      if (current.role === "host") {
        if (!(yield* isCatchingUp)) {
          yield* publish(event === "seeked");

          return;
        }

        if (event === "paused") {
          const echo = yield* Ref.modify(pauseEchoes, (count) =>
            count > 0 ? [true, count - 1] : [false, 0],
          );

          if (!echo) yield* serial.withPermits(1)(Effect.andThen(endCatchUp, publishNow(false)));

          return;
        }

        if (event === "seeked") {
          const landed = player.positionMs();
          const now = yield* serverNow;

          const onClock = Option.match(now, {
            onNone: () => true,
            onSome: (at) => Math.abs(landed - targetPosition(current.clock, at)) <= tunables.seekMs,
          });

          const echo = yield* Ref.modify(catchUpSeeks, (targets) => {
            const at = targets.findIndex((target) => Math.abs(landed - target) <= tunables.seekMs);

            if (at !== -1) return [true, targets.slice(at + 1)];

            return [onClock, onClock ? targets.slice(1) : targets];
          });

          if (!echo) {
            yield* serial.withPermits(1)(Effect.andThen(endCatchUp, publishNow(true)));

            return;
          }
        }

        if (event === "playing" || event === "seeked") yield* correct;

        return;
      }

      if (event === "waiting") {
        if (current.follow === "following") {
          yield* update((latest) => ({ ...latest, follow: "buffering" }));
        }

        return;
      }

      if (event === "paused") {
        const echo = yield* Ref.modify(pauseEchoes, (count) =>
          count > 0 ? [true, count - 1] : [false, 0],
        );

        if (!echo && current.clock.status === "playing" && current.follow !== "ended") {
          yield* update((latest) => ({ ...latest, follow: "detached" }));
        }

        return;
      }

      if (event === "playing" && current.follow !== "following" && current.follow !== "ended") {
        yield* update((latest) => ({ ...latest, follow: "following" }));
      }

      if (event === "playing" || event === "seeked") yield* correct;
    });

  const heartbeatArgs = (
    current: RoomSyncState,
    now: Option.Option<EpochMillis>,
    catching: boolean,
  ): CommandArgs<"rooms.heartbeat"> => {
    if (current.follow === "moved") return { roomId, deviceId, presence: "away" };

    if (current.role === "host" && catching) return { roomId, deviceId };

    if (current.role === "host") {
      return {
        roomId,
        deviceId,
        positionMs: Milliseconds.make(Math.max(0, player.positionMs())),
        ...Option.match(now, { onNone: () => ({}), onSome: (atServerTime) => ({ atServerTime }) }),
        revision: current.clock.revision,
        fileId,
      };
    }

    if (current.follow === "following" && current.driftMs !== null) {
      return { roomId, deviceId, driftMs: current.driftMs };
    }

    return { roomId, deviceId };
  };

  const beat = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      const now = yield* serverNow;
      const catching = yield* isCatchingUp;

      if (!catching && Option.isSome(yield* Ref.get(catchingUpSince))) {
        yield* endCatchUp;
        yield* publishNow(false);
      }

      const clock = yield* client.mutate("rooms.heartbeat", heartbeatArgs(current, now, catching));

      return {
        newer: yield* applyClock(clock),
        wasReconnecting: current.connection === "reconnecting",
      };
    }),
  );

  const heartbeat = Effect.gen(function* () {
    const { clock } = yield* SubscriptionRef.get(state);

    if (clock.status === "ended") return;

    const answered = yield* beat.pipe(
      Effect.timeoutOption(Duration.millis(tunables.heartbeatTimeoutMs)),
      Effect.catchTag("TransportError", () => Effect.succeedNone),
    );

    if (Option.isNone(answered)) {
      yield* markReconnecting;

      return;
    }

    const { newer, wasReconnecting } = answered.value;

    yield* update((latest) => ({ ...latest, connection: "connected" }));

    if (wasReconnecting) {
      yield* resync.pipe(Effect.catch(() => markReconnecting));

      return;
    }

    if (newer) yield* correct;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("RoomSync.heartbeatRejected", error).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  const subscription = client.subscribe("rooms.get", { roomId }).pipe(
    Stream.runForEach((room) =>
      Effect.gen(function* () {
        const newer = yield* adopt(room);

        if (newer) yield* correct;
      }),
    ),
    Effect.tapError(() => markReconnecting),
    Effect.retry({
      while: (error) =>
        !Predicate.isTagged(error, "NotFound") && !Predicate.isTagged(error, "Forbidden"),
      schedule: Schedule.spaced(Duration.millis(tunables.resubscribeDelayMs)),
    }),
    Effect.catch((error) =>
      Effect.logWarning("RoomSync.subscriptionEnded", error).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  const events = yield* playerEvents(player);

  yield* addSamples();

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);

      player.setPlaybackRate(clock.playbackRate);
    }),
  );

  if (role === "host") yield* joinLiveClock;

  yield* Effect.forkScoped(Stream.runForEach(events, onPlayerEvent));
  yield* Effect.forkScoped(subscription);
  yield* Effect.forkScoped(
    heartbeat.pipe(Effect.repeat(Schedule.spaced(Duration.millis(tunables.heartbeatIntervalMs)))),
  );
  yield* Effect.forkScoped(
    addSamples().pipe(
      Effect.delay(Duration.millis(tunables.offsetRefreshIntervalMs)),
      Effect.forever,
    ),
  );

  const correcting = Schedule.spaced(Duration.millis(tunables.correctionIntervalMs));

  if (role === "guest") {
    yield* Effect.forkScoped(correct.pipe(Effect.repeat(correcting)));
  } else {
    yield* Effect.forkScoped(
      correct.pipe(
        Effect.andThen(Effect.map(Ref.get(catchingUpSince), Option.isSome)),
        Effect.repeat({ schedule: correcting, while: (catching) => catching }),
      ),
    );
    yield* publish(false);
  }

  const handle: RoomSync = {
    state: SubscriptionRef.changes(state),
    current: SubscriptionRef.get(state),
  };

  return handle;
});
