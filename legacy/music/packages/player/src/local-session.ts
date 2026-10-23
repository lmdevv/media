/**
 * A device's own playback session, for while it can't reach the server: the same queue and the
 * same rules (`@music/commands/queue-rules`) as the server's session, applied on this device to
 * the songs it holds copies of. Pure: each command is one step from a state to the next, which
 * the session router persists and later hands back to the server whole (`devices.reconcile`).
 */
import type { DeviceId } from "@music/commands/ids";
import { QueueItemId, TrackId } from "@music/commands/ids";
import type { DeviceKind, OfflineResume, PlaybackState, QueueEntry } from "@music/commands/models";
import {
  Contributor,
  Millis,
  OfflinePlay,
  RepeatMode,
  Timestamp,
  Track,
} from "@music/commands/models";
import {
  MAX_QUEUE,
  addedOrder,
  isNewPlay,
  isStaleReport,
  keptOrder,
  movedInOrder,
  nextIndex,
  playOrder,
  previousIndex,
  shuffledOff,
  shuffledOn,
  withoutUpcomingAutoplay,
} from "@music/commands/queue-rules";
import type { CommandArgs, CommandResult } from "@music/commands/registry";
import type { SessionMutation } from "@music/commands/session-commands";
import type { CommandFailure } from "@music/sdk/errors";
import { Data, Result, Schema, Struct } from "effect";

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One queue entry: its own ID, who added it, whether autoplay did, and its song. */
const LocalEntry = Schema.Struct({
  /** The server's entry ID for entries the session began with; `local-<n>` for ones added here. */
  id: QueueItemId,
  autoplay: Schema.Boolean,
  addedBy: Schema.NullOr(Contributor),
  track: Track,
});

type LocalEntry = typeof LocalEntry.Type;

/**
 * A device's own session, in the shape its store keeps it. Stored data is read back through this
 * schema, so a row from an older or damaged store never reaches the player unparsed.
 */
export const LocalSessionState = Schema.Struct({
  items: Schema.Array(LocalEntry),
  index: Index,
  /** The entry IDs in their order before shuffle, while shuffle is on and the order is known. */
  unshuffled: Schema.optional(Schema.Array(QueueItemId)),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  /** The server's autoplay setting, kept for when the session goes back; nothing tops up here. */
  autoplay: Schema.Boolean,
  /** True at `updatedAt`; while playing, the live position runs on from there. */
  positionMs: Millis,
  updatedAt: Timestamp,
  playing: Schema.Boolean,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** The number in the next entry ID made here. */
  nextItem: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The song whose play was counted last; another report of it is the same play. */
  reportedTrackId: Schema.NullOr(TrackId),
  /** When a command last moved the session to another entry, for `isStaleReport`. */
  movedAt: Schema.NullOr(Timestamp),
  /**
   * A command ran here since the session left the server. Until one does, the server's session
   * stands, and only the plays go back.
   */
  changed: Schema.Boolean,
  /** Plays to hand to the server's history, in the order they started. */
  plays: Schema.Array(OfflinePlay),
});

/** A device's own session. */
export type LocalSessionState = typeof LocalSessionState.Type;

/** This device, where a local session always plays. */
export interface LocalDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly kind: DeviceKind;
}

/** A song as a device holds it: the server alone knows whether the listener likes it. */
export type PlayableTrack = Omit<Track, "liked">;

/** What one step reads besides the state. */
export interface LocalContext {
  /** Now, on this device's clock. */
  readonly now: number;
  readonly device: LocalDevice;
  /** A song this device can play without the server (it holds a copy), or null. */
  readonly playable: (trackId: TrackId) => PlayableTrack | null;
  /** Uniform in `[0, 1)`, for shuffling. */
  readonly random: () => number;
}

/** Why the local session refused a command. */
export type LocalRefusal = Data.TaggedEnum<{
  /** The command needs the server, such as moving playback to another device. */
  Offline: {};
  /** None of the songs asked for has a copy on this device. */
  NotDownloaded: {};
  /** The entry is no longer in the queue. */
  Gone: {};
  /** Nothing is queued, so nothing can resume. */
  Empty: {};
  /** An entry can't move after itself. */
  AfterItself: {};
}>;

/** Constructors and matchers for `LocalRefusal`. */
export const LocalRefusal = Data.taggedEnum<LocalRefusal>();

/**
 * What a refusal tells the listener, with the code the server would send for the same refusal,
 * so the player shows it like any failed command.
 */
export const refusalFailure = (refusal: LocalRefusal): CommandFailure =>
  LocalRefusal.$match(refusal, {
    Offline: () => ({ code: "offline", message: "Not available offline" }),
    NotDownloaded: () => ({ code: "not_found", message: "Only downloaded songs play offline" }),
    Gone: () => ({ code: "not_found", message: "That song is no longer in the queue" }),
    Empty: () => ({ code: "conflict", message: "The queue is empty" }),
    AfterItself: () => ({ code: "invalid_args", message: "An entry can't move after itself" }),
  });

/** A command applied: the session after it, and what the command answers. */
export interface LocalStep<Name extends SessionMutation> {
  readonly state: LocalSessionState;
  readonly result: CommandResult<Name>;
}

/**
 * One handler per session command. A mapped type over the registry's session commands: a new
 * `playback.*` or `queue.*` command fails the build here until the local session handles it or
 * refuses it.
 */
type LocalHandlers = {
  readonly [Name in SessionMutation]: (
    state: LocalSessionState,
    args: CommandArgs<Name>,
    context: LocalContext,
  ) => Result.Result<LocalStep<Name>, LocalRefusal>;
};

const ok = { ok: true } as const;

const live = (state: LocalSessionState, now: number): number =>
  state.playing ? state.positionMs + Math.max(0, now - state.updatedAt) : state.positionMs;

const isPlayable = (entry: LocalEntry | undefined, context: LocalContext): boolean =>
  entry !== undefined && context.playable(entry.track.id) !== null;

const movedTo = (state: LocalSessionState, index: number, now: number): LocalSessionState => ({
  ...state,
  index,
  positionMs: 0,
  updatedAt: now,
  movedAt: now,
  reportedTrackId: null,
});

const newEntries = (
  state: LocalSessionState,
  tracks: ReadonlyArray<PlayableTrack>,
): ReadonlyArray<LocalEntry> =>
  tracks.map((track, offset) => ({
    id: QueueItemId.make(`local-${state.nextItem + offset}`),
    autoplay: false,
    addedBy: null,
    track: { ...track, liked: false },
  }));

/** Songs without a copy drop out, as the server drops songs whose file is missing. */
const playableSongs = (trackIds: ReadonlyArray<TrackId>, index: number, context: LocalContext) => {
  const found = trackIds.map((trackId) => context.playable(trackId));
  const tracks = found.filter((track) => track !== null);
  const before = found.slice(0, index).filter((track) => track !== null).length;

  return { tracks, index: Math.min(before, Math.max(0, tracks.length - 1)) };
};

const nextPlayable = (state: LocalSessionState, context: LocalContext): number | null => {
  let index = nextIndex(state.index, state.items.length, state.repeat);

  for (let tried = 0; index !== null && tried < state.items.length; tried += 1) {
    if (isPlayable(state.items[index], context)) return index;
    index = nextIndex(index, state.items.length, state.repeat);
  }

  return null;
};

const previousPlayable = (state: LocalSessionState, context: LocalContext): number => {
  const { length } = state.items;
  let index = previousIndex(live(state, context.now), state.index, length, state.repeat);

  for (let tried = 0; index !== state.index && tried < length; tried += 1) {
    if (isPlayable(state.items[index], context)) return index;
    const before = previousIndex(0, index, length, state.repeat);

    if (before === index) break;
    index = before;
  }

  return state.index;
};

const step = <Name extends SessionMutation>(
  state: LocalSessionState,
  result: CommandResult<Name>,
): Result.Result<LocalStep<Name>, LocalRefusal> => Result.succeed({ state, result });

const localHandlers: LocalHandlers = {
  "playback.play": (state, args, context) => {
    if (args.deviceId !== undefined && args.deviceId !== context.device.id) {
      return Result.fail(LocalRefusal.Offline());
    }

    const songs = playableSongs(args.trackIds, args.index ?? 0, context);

    if (songs.tracks.length === 0) return Result.fail(LocalRefusal.NotDownloaded());
    const created = newEntries(state, songs.tracks);
    const order = playOrder(created, songs.index, state.shuffle, context.random);

    return step(
      {
        ...movedTo(state, order.index, context.now),
        ...order,
        nextItem: state.nextItem + created.length,
        playing: true,
      },
      ok,
    );
  },

  "playback.pause": (state, _args, context) =>
    step(
      { ...state, positionMs: live(state, context.now), playing: false, updatedAt: context.now },
      ok,
    ),

  "playback.resume": (state, _args, context) =>
    state.items.length === 0
      ? Result.fail(LocalRefusal.Empty())
      : step({ ...state, playing: true, updatedAt: context.now }, ok),

  "playback.next": (state, _args, context) => {
    const index = nextPlayable(state, context);

    // Autoplay needs the server, so a queue that runs out here stops.
    return index === null
      ? step({ ...movedTo(state, state.index, context.now), playing: false }, ok)
      : step(movedTo(state, index, context.now), ok);
  },

  "playback.previous": (state, _args, context) =>
    step(movedTo(state, previousPlayable(state, context), context.now), ok),

  "playback.seek": (state, args, context) =>
    step({ ...state, positionMs: args.positionMs, updatedAt: context.now }, ok),

  "playback.jump": (state, args, context) => {
    const index = state.items.findIndex((entry) => entry.id === args.itemId);

    if (index === -1) return Result.fail(LocalRefusal.Gone());

    if (!isPlayable(state.items[index], context)) return Result.fail(LocalRefusal.NotDownloaded());

    return step({ ...movedTo(state, index, context.now), playing: true }, ok);
  },

  "playback.shuffle": (state, args, context) => {
    if (args.on === state.shuffle) return step(state, ok);

    const order = args.on ? shuffledOn(state, context.random) : shuffledOff(state);

    return step({ ...state, ...order, shuffle: args.on }, ok);
  },

  "playback.repeat": (state, args) => step({ ...state, repeat: args.mode }, ok),

  "playback.volume": (state, args) => step({ ...state, volume: args.volume }, ok),

  "playback.transfer": (state, args, context) =>
    args.deviceId === context.device.id ? step(state, ok) : Result.fail(LocalRefusal.Offline()),

  "playback.report": (state, args, context) => {
    if (args.deviceId !== context.device.id) return step(state, ok);

    const index =
      args.itemId === undefined
        ? args.index
        : state.items.findIndex((entry) => entry.id === args.itemId);

    const entry = state.items[index];

    if (
      entry === undefined ||
      (args.trackId !== undefined && args.trackId !== entry.track.id) ||
      isStaleReport(index, state.index, state.movedAt, context.now)
    ) {
      return step(state, ok);
    }

    const newPlay = isNewPlay(
      { trackId: entry.track.id, positionMs: args.positionMs, playing: args.playing },
      { trackId: state.reportedTrackId, livePositionMs: live(state, context.now) },
      entry.track.durationMs,
    );

    return step(
      {
        ...state,
        index,
        positionMs: args.positionMs,
        playing: args.playing,
        updatedAt: context.now,
        reportedTrackId: newPlay ? entry.track.id : state.reportedTrackId,
        plays: newPlay
          ? [...state.plays, { trackId: entry.track.id, playedAt: context.now }]
          : state.plays,
      },
      ok,
    );
  },

  "queue.add": (state, args, context) => {
    const songs = playableSongs(args.trackIds, 0, context);

    if (songs.tracks.length === 0) return Result.fail(LocalRefusal.NotDownloaded());
    const created = newEntries(state, songs.tracks);
    const nextItem = state.nextItem + created.length;

    if (state.items.length === 0) {
      const items = created.slice(0, MAX_QUEUE);
      const ids = items.map((entry) => entry.id);

      return step(
        {
          ...movedTo(state, 0, context.now),
          items,
          unshuffled: state.shuffle ? ids : undefined,
          nextItem,
          playing: false,
        },
        { ok: true, itemIds: ids },
      );
    }

    const order = addedOrder(state, created, args.next === true ? "next" : "end");
    const kept = new Set(order.items.map((entry) => entry.id));

    return step(
      { ...state, ...order, nextItem },
      { ok: true, itemIds: created.flatMap((entry) => (kept.has(entry.id) ? [entry.id] : [])) },
    );
  },

  "queue.remove": (state, args, context) => {
    const position = state.items.findIndex((entry) => entry.id === args.itemId);

    if (position === -1) return Result.fail(LocalRefusal.Gone());
    const items = state.items.filter((entry) => entry.id !== args.itemId);

    const remaining = {
      ...state,
      items,
      unshuffled: state.unshuffled === undefined ? undefined : keptOrder(state.unshuffled, items),
    };

    if (position < state.index) return step({ ...remaining, index: state.index - 1 }, ok);

    if (position > state.index) return step(remaining, ok);
    const index = Math.min(state.index, Math.max(0, items.length - 1));

    return step(
      { ...movedTo(remaining, index, context.now), playing: state.playing && items.length > 0 },
      ok,
    );
  },

  "queue.move": (state, args) => {
    const moving = state.items.find((entry) => entry.id === args.itemId);

    if (moving === undefined) return Result.fail(LocalRefusal.Gone());

    if (args.afterItemId === args.itemId) return Result.fail(LocalRefusal.AfterItself());
    const rest = state.items.filter((entry) => entry.id !== args.itemId);

    const after =
      args.afterItemId === undefined
        ? -1
        : rest.findIndex((entry) => entry.id === args.afterItemId);

    if (after === -1 && args.afterItemId !== undefined) return Result.fail(LocalRefusal.Gone());
    const items = [...rest.slice(0, after + 1), moving, ...rest.slice(after + 1)];
    const current = state.items[state.index];
    const index = current === undefined ? 0 : items.findIndex((entry) => entry.id === current.id);

    return step(
      {
        ...state,
        items,
        index: Math.max(0, index),
        unshuffled:
          state.unshuffled === undefined
            ? undefined
            : movedInOrder(state.unshuffled, args.itemId, args.afterItemId),
      },
      ok,
    );
  },

  "queue.clear": (state) => {
    const items = state.items.slice(0, state.index + 1);

    return step(
      {
        ...state,
        items,
        unshuffled: state.unshuffled === undefined ? undefined : keptOrder(state.unshuffled, items),
      },
      ok,
    );
  },

  "queue.autoplay": (state, args) =>
    args.on
      ? step({ ...state, autoplay: true }, ok)
      : step({ ...state, ...withoutUpcomingAutoplay(state), autoplay: false }, ok),
};

/**
 * Applies one session command to a device's own session.
 *
 * @returns The session after the command and the command's answer, or why the command can't run
 *   without the server or on these songs.
 */
export const stepLocal = <Name extends SessionMutation>(
  name: Name,
  state: LocalSessionState,
  args: CommandArgs<Name>,
  context: LocalContext,
): Result.Result<LocalStep<Name>, LocalRefusal> => {
  const handler: LocalHandlers[Name] = localHandlers[name];

  return Result.map(handler(state, args, context), (stepped) => ({
    state: { ...stepped.state, changed: true },
    result: stepped.result,
  }));
};

/** The number in an entry ID made here (`local-<n>`), or 0 for any other ID. */
const localNumber = (itemId: string): number => {
  const match = /^local-(\d+)$/.exec(itemId);

  return match?.[1] === undefined ? 0 : Number(match[1]);
};

const entryOf = (entry: QueueEntry): LocalEntry => ({
  id: entry.itemId,
  autoplay: entry.autoplay,
  addedBy: entry.addedBy,
  track: Struct.omit(entry, ["itemId", "addedBy", "autoplay", "withheld"]),
});

/**
 * A device's own session, taken over from the server's last snapshot as the connection drops.
 * Its view is the server's, so audio carries on untouched: same queue, entry IDs, position, and
 * clock reference. It plays only if it played on this device.
 */
export const seedLocal = (server: PlaybackState, device: DeviceId): LocalSessionState => ({
  items: server.queue.map(entryOf),
  index: server.index,
  // The server keeps its order before shuffle to itself; turning shuffle off here keeps the order.
  unshuffled: undefined,
  shuffle: server.shuffle,
  repeat: server.repeat,
  autoplay: server.autoplay,
  positionMs: server.positionMs,
  updatedAt: server.updatedAt,
  playing: server.activeDevice?.id === device && server.playing,
  volume: server.volume,
  // The view may already hold entries made here, if the session left the server again quickly.
  nextItem: 1 + Math.max(0, ...server.queue.map((entry) => localNumber(entry.itemId))),
  // The server counted the current song when it started; counting it again would double it.
  reportedTrackId: server.queue[server.index]?.id ?? null,
  movedAt: null,
  changed: false,
  plays: [],
});

/** A device's own session with nothing queued, for a device with no session to resume. */
export const emptyLocal = (now: number): LocalSessionState => ({
  items: [],
  index: 0,
  unshuffled: undefined,
  shuffle: false,
  repeat: "off",
  autoplay: true,
  positionMs: 0,
  updatedAt: now,
  playing: false,
  volume: 1,
  nextItem: 1,
  reportedTrackId: null,
  movedAt: null,
  changed: false,
  plays: [],
});

/** The session as the player shows it: playing on this device, never following anyone. */
export const localView = (state: LocalSessionState, device: LocalDevice): PlaybackState => ({
  activeDevice: {
    id: device.id,
    name: device.name,
    kind: device.kind,
    lastSeenAt: state.updatedAt,
    online: true,
  },
  positionMs: state.positionMs,
  playing: state.playing,
  updatedAt: state.updatedAt,
  volume: state.volume,
  following: false,
  queue: state.items.map((entry) =>
    Struct.assign(entry.track, {
      itemId: entry.id,
      addedBy: entry.addedBy,
      autoplay: entry.autoplay,
    }),
  ),
  index: state.index,
  shuffle: state.shuffle,
  repeat: state.repeat,
  autoplay: state.autoplay,
});

/**
 * Where the session stands at `now`, as `devices.reconcile` takes it; null while no command ran
 * here, so the server's session stands.
 */
export const offlineResume = (state: LocalSessionState, now: number): OfflineResume | null =>
  state.changed
    ? {
        items: state.items.map((entry) => ({ trackId: entry.track.id, itemId: entry.id })),
        index: state.index,
        positionMs: Math.round(live(state, now)),
        playing: state.playing,
        shuffle: state.shuffle,
        repeat: state.repeat,
        volume: state.volume,
        autoplay: state.autoplay,
      }
    : null;
