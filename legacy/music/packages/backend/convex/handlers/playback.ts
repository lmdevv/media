import type { PlaybackPosition, PlaybackQueue } from "@music/commands/models";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEVICE_LISTED_MS, DEVICE_LIST_LIMIT, listedDevices } from "../lib/devices";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { MAX_QUEUE, ensureSession, findSession, livePosition, shuffled } from "../lib/playback";
import { DEVICE_ONLINE_MS, makePresenter, presentDevice } from "../lib/present";
import { loadQueue, normaliseStored, restrictTo, saveQueue, storedQueue } from "../lib/queue";
import type { StoredQueue } from "../lib/queue";
import { canRead } from "../lib/viewer";
import type { ReadCtx, Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

const RESTART_THRESHOLD_MS = 3000;

/**
 * A report this close to the start of the song history last recorded, after the session had
 * played this much further, is the same song starting again (repeat one, or a seek back to the
 * start), so it counts as another play.
 */
const REPLAY_GAP_MS = 10_000;

/** How long after a command moves the queue a report naming another song counts as stale. */
const MOVE_GRACE_MS = 3000;

const findDevice = (ctx: ReadCtx, userId: Id<"users">, deviceId: string) =>
  ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .unique();

/**
 * Parses track IDs the viewer may read, keeping their order, and leaves out songs whose file is
 * gone (a playlist can still list them). `index` moves to the same song, or to the next one kept.
 * Fails when nothing is left to play.
 */
const playableTracks = async (
  ctx: MutationCtx,
  viewer: Viewer,
  ids: ReadonlyArray<string>,
  index = 0,
): Promise<{ readonly ids: Array<Id<"tracks">>; readonly index: number }> => {
  const tracks = await Promise.all(ids.map((id) => ctx.db.get(tableId(ctx, "tracks", id))));

  const readable = tracks.map((track, position) =>
    track === null || !canRead(viewer, track.libraryId)
      ? fail("not_found", `Track ${ids[position] ?? ""} not found`)
      : track,
  );

  const kept = readable.flatMap((track) => (track.missing ? [] : [track._id]));

  if (kept.length === 0) {
    return fail("not_found", "None of those songs can play: their files are missing");
  }

  const before = readable.slice(0, index).filter((track) => !track.missing).length;

  return { ids: kept, index: Math.min(before, kept.length - 1) };
};

/**
 * Where a reported song is in the queue. A player sends the index it was shown; when the queue
 * shifted before it saw the change (a song went missing or was removed), the song it names is at
 * another index, so the occurrence nearest the reported one wins. Null when the song is gone.
 */
const reportedIndex = (
  queue: ReadonlyArray<Id<"tracks">>,
  index: number,
  trackId: string | undefined,
): number | null => {
  if (trackId === undefined) return index < queue.length ? index : null;

  if (queue[index] === trackId) return index;

  const positions = queue.flatMap((id, position) => (id === trackId ? [position] : []));

  const [nearest] = positions.toSorted(
    (left, right) => Math.abs(left - index) - Math.abs(right - index),
  );

  return nearest ?? null;
};

/**
 * The queue, and the index and song a position report names. Reports arrive every few seconds,
 * so when the stored queue holds the named song at the reported index (every write saves the
 * queue as the viewer sees it, so this is the usual case) only that song is read. Otherwise, as
 * after a library was deleted, the whole queue is loaded and normalised, and the index is the one
 * the client was shown.
 */
const locateReport = async (
  ctx: MutationCtx,
  viewer: Viewer,
  reported: number,
  trackId: string | undefined,
): Promise<{
  readonly queue: StoredQueue;
  readonly index: number;
  readonly track: Doc<"tracks">;
} | null> => {
  const stored = await storedQueue(ctx, viewer.id);
  const storedId = stored.queue[reported];

  if (trackId !== undefined && storedId === trackId) {
    const track = await ctx.db.get(storedId);

    if (track !== null && canRead(viewer, track.libraryId)) {
      return { queue: stored, index: reported, track };
    }
  }

  const queue = await normaliseStored(ctx, stored, (track) => canRead(viewer, track.libraryId));
  const index = reportedIndex(queue.queue, reported, trackId);
  const track = index === null ? undefined : queue.tracks[index];

  return index === null || track === undefined ? null : { queue, index, track };
};

/** Picks the device that should play when the caller did not name one. */
const defaultDevice = async (
  ctx: MutationCtx,
  viewer: Viewer,
  session: Doc<"playbackSessions">,
): Promise<string | undefined> => {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", viewer.id))
    .collect();

  const now = Date.now();
  const online = devices.filter((device) => now - device.lastSeenAt < DEVICE_ONLINE_MS);

  // Keep the active device while it is online; otherwise hand playback to the player that was
  // seen most recently, so a closed tab does not keep "playing" with nobody listening.
  if (online.some((device) => device.deviceId === session.activeDeviceId)) {
    return session.activeDeviceId;
  }

  const players = online
    .filter((device) => device.kind !== "cli")
    .toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);

  return players[0]?.deviceId ?? session.activeDeviceId;
};

/** The session's device, position, and volume. Reads only the session and its device. */
const positionOf = async (
  ctx: ReadCtx,
  viewer: Viewer,
): Promise<(typeof PlaybackPosition)["Encoded"]> => {
  const session = await findSession(ctx, viewer.id);

  if (session === null) {
    return { activeDevice: null, positionMs: 0, playing: false, updatedAt: 0, volume: 1 };
  }

  const device =
    session.activeDeviceId === undefined
      ? null
      : await findDevice(ctx, viewer.id, session.activeDeviceId);

  return {
    activeDevice: device === null ? null : presentDevice(device, Date.now()),
    positionMs: session.positionMs,
    playing: session.playing,
    updatedAt: session.updatedAt,
    volume: session.volume,
  };
};

/** The queue the viewer may play. Reads neither the session nor its device. */
const queueOf = async (
  ctx: ReadCtx,
  viewer: Viewer,
): Promise<(typeof PlaybackQueue)["Encoded"]> => {
  const queue = await loadQueue(ctx, viewer);

  return {
    queue: await makePresenter(ctx, viewer).tracks(queue.tracks),
    index: queue.index,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
  };
};

export const playbackQueries = {
  "playback.state": async (ctx, viewer) => {
    const [position, queue] = await Promise.all([positionOf(ctx, viewer), queueOf(ctx, viewer)]);

    return { ...position, ...queue };
  },

  "playback.position": positionOf,

  "queue.list": queueOf,

  "devices.list": async (ctx, viewer, args) => {
    const session = await findSession(ctx, viewer.id);
    const now = Date.now();

    // Long-silent devices drop out, but never the one playing the session or the one asking: a
    // browser waking after a day lists itself before its first heartbeat lands.
    const keep = new Set(
      [session?.activeDeviceId, args.deviceId].filter((id): id is string => id !== undefined),
    );

    // Only the listed range is read, so a long device history costs the list nothing; the kept
    // devices are looked up on their own.
    const recent = await ctx.db
      .query("devices")
      .withIndex("by_user_last_seen", (q) =>
        q.eq("userId", viewer.id).gt("lastSeenAt", now - DEVICE_LISTED_MS),
      )
      .order("desc")
      .take(DEVICE_LIST_LIMIT);

    const kept = await Promise.all(
      [...keep].map((deviceId) => findDevice(ctx, viewer.id, deviceId)),
    );

    const devices = new Map(
      [...recent, ...kept.filter((device) => device !== null)].map((device) => [
        device.deviceId,
        device,
      ]),
    );

    return listedDevices([...devices.values()], now, keep)
      .toSorted((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((device) => presentDevice(device, now));
  },
} satisfies Partial<QueryHandlers>;

export const playbackMutations = {
  "playback.play": async (ctx, viewer, args) => {
    if (args.deviceId !== undefined && (await findDevice(ctx, viewer.id, args.deviceId)) === null) {
      return fail("not_found", "That device is not registered");
    }

    const session = await ensureSession(ctx, viewer.id);
    const stored = await storedQueue(ctx, viewer.id);
    const playable = await playableTracks(ctx, viewer, args.trackIds, args.index);
    let queue = playable.ids;
    let { index } = playable;
    let unshuffled: Array<Id<"tracks">> | undefined;

    if (stored.shuffle) {
      // Shuffle the whole list, then keep `MAX_QUEUE` of it: a long list shuffled from a random
      // song near its end still fills the queue.
      const current = queue[index];
      const rest = shuffled(queue.filter((_, position) => position !== index));
      const order = current === undefined ? rest : [current, ...rest];
      const kept = order.slice(0, MAX_QUEUE);
      unshuffled = restrictTo(queue, kept);
      queue = kept;
      index = 0;
    } else if (queue.length > MAX_QUEUE) {
      queue = queue.slice(index, index + MAX_QUEUE);
      index = 0;
    }

    await saveQueue(ctx, viewer.id, {
      ...stored,
      queue,
      unshuffled,
      index,
      reportedTrackId: undefined,
    });

    const activeDeviceId = args.deviceId ?? (await defaultDevice(ctx, viewer, session));
    await ctx.db.patch(session._id, {
      positionMs: 0,
      movedAt: Date.now(),
      playing: true,
      updatedAt: Date.now(),
      activeDeviceId,
    });

    return ok;
  },

  "playback.pause": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      positionMs: livePosition(session, now),
      playing: false,
      updatedAt: now,
    });

    return ok;
  },

  "playback.resume": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);

    if (queue.tracks.length === 0) return fail("conflict", "The queue is empty");
    await saveQueue(ctx, viewer.id, queue);
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, { playing: true, updatedAt: Date.now(), activeDeviceId });

    return ok;
  },

  "playback.next": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const now = Date.now();
    const last = queue.tracks.length - 1;
    // Whatever comes next starts from the top, so it counts as a new play.
    const restart = { ...queue, reportedTrackId: undefined };

    if (queue.index < last) {
      await saveQueue(ctx, viewer.id, { ...restart, index: queue.index + 1 });
      await ctx.db.patch(session._id, { positionMs: 0, updatedAt: now, movedAt: now });
    } else if (queue.repeat === "all" && queue.tracks.length > 0) {
      await saveQueue(ctx, viewer.id, { ...restart, index: 0 });
      await ctx.db.patch(session._id, { positionMs: 0, updatedAt: now, movedAt: now });
    } else {
      await saveQueue(ctx, viewer.id, restart);
      await ctx.db.patch(session._id, {
        positionMs: 0,
        playing: false,
        updatedAt: now,
        movedAt: now,
      });
    }

    return ok;
  },

  "playback.previous": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const now = Date.now();
    const position = livePosition(session, now);

    const index =
      position > RESTART_THRESHOLD_MS
        ? queue.index
        : queue.index > 0
          ? queue.index - 1
          : queue.repeat === "all"
            ? Math.max(0, queue.tracks.length - 1)
            : 0;

    await saveQueue(ctx, viewer.id, { ...queue, index, reportedTrackId: undefined });
    await ctx.db.patch(session._id, { positionMs: 0, updatedAt: now, movedAt: now });

    return ok;
  },

  "playback.seek": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { positionMs: args.positionMs, updatedAt: Date.now() });

    return ok;
  },

  "playback.jump": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);

    if (args.index >= queue.tracks.length) return fail("invalid_args", "No song at that index");
    await saveQueue(ctx, viewer.id, { ...queue, index: args.index, reportedTrackId: undefined });
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, {
      positionMs: 0,
      movedAt: Date.now(),
      playing: true,
      updatedAt: Date.now(),
      activeDeviceId,
    });

    return ok;
  },

  "playback.shuffle": async (ctx, viewer, args) => {
    const queue = await loadQueue(ctx, viewer);

    if (args.on === queue.shuffle) {
      await saveQueue(ctx, viewer.id, queue);

      return ok;
    }

    const current = queue.queue[queue.index];

    if (args.on) {
      const rest = shuffled(queue.queue.filter((_, position) => position !== queue.index));
      await saveQueue(ctx, viewer.id, {
        ...queue,
        shuffle: true,
        unshuffled: queue.queue,
        queue: current === undefined ? rest : [current, ...rest],
        index: 0,
      });
    } else {
      const original = queue.unshuffled ?? queue.queue;
      await saveQueue(ctx, viewer.id, {
        ...queue,
        shuffle: false,
        unshuffled: undefined,
        queue: original,
        index: current === undefined ? 0 : Math.max(0, original.indexOf(current)),
      });
    }

    return ok;
  },

  "playback.repeat": async (ctx, viewer, args) => {
    const queue = await loadQueue(ctx, viewer);
    await saveQueue(ctx, viewer.id, { ...queue, repeat: args.mode });

    return ok;
  },

  "playback.volume": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { volume: args.volume });

    return ok;
  },

  "playback.transfer": async (ctx, viewer, args) => {
    const device = await findDevice(ctx, viewer.id, args.deviceId);

    if (device === null) return fail("not_found", "That device is not registered");
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      activeDeviceId: device.deviceId,
      positionMs: livePosition(session, now),
      updatedAt: now,
    });

    return ok;
  },

  "playback.report": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);

    if (session.activeDeviceId !== args.deviceId) return ok;
    const located = await locateReport(ctx, viewer, args.index, args.trackId);

    if (located === null) return ok;
    const { queue, index, track } = located;
    const now = Date.now();

    // A report sent before the player saw a skip or jump would move the queue back to the old
    // song; the player reports again once it plays the new one.
    if (
      index !== queue.index &&
      session.movedAt !== undefined &&
      now - session.movedAt < MOVE_GRACE_MS
    ) {
      return ok;
    }

    // A short song loops sooner than the gap, so its gap is half its length.
    const gap = Math.min(REPLAY_GAP_MS, track.durationMs / 2);

    const startedAgain =
      track._id === queue.reportedTrackId &&
      args.positionMs < gap &&
      livePosition(session, now) - args.positionMs > gap;

    const newPlay = args.playing && (track._id !== queue.reportedTrackId || startedAgain);

    await ctx.db.patch(session._id, {
      positionMs: args.positionMs,
      playing: args.playing,
      updatedAt: now,
    });

    await saveQueue(ctx, viewer.id, {
      ...queue,
      index,
      reportedTrackId: newPlay ? track._id : queue.reportedTrackId,
    });

    if (newPlay) {
      await ctx.db.insert("history", {
        userId: viewer.id,
        trackId: track._id,
        albumId: track.albumId,
        deviceId: args.deviceId,
      });
    }

    return ok;
  },

  "queue.add": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const added = (await playableTracks(ctx, viewer, args.trackIds)).ids;

    if (queue.tracks.length === 0) {
      const ids = added.slice(0, MAX_QUEUE);

      await saveQueue(ctx, viewer.id, {
        ...queue,
        queue: ids,
        unshuffled: queue.shuffle ? ids : undefined,
        index: 0,
        reportedTrackId: undefined,
      });

      await ctx.db.patch(session._id, {
        positionMs: 0,
        playing: false,
        updatedAt: Date.now(),
        movedAt: Date.now(),
      });

      return ok;
    }

    const insertAt = args.next === true ? queue.index + 1 : queue.queue.length;

    const next = [
      ...queue.queue.slice(0, insertAt),
      ...added,
      ...queue.queue.slice(insertAt),
    ].slice(0, MAX_QUEUE);

    // Added songs join the unshuffled order too, after the current song or at the end, so
    // turning shuffle off keeps them.
    const current = queue.queue[queue.index];

    const unshuffledAt = (order: ReadonlyArray<Id<"tracks">>): number =>
      args.next === true && current !== undefined ? order.indexOf(current) + 1 : order.length;

    const unshuffled =
      queue.unshuffled === undefined
        ? undefined
        : restrictTo(
            [
              ...queue.unshuffled.slice(0, unshuffledAt(queue.unshuffled)),
              ...added,
              ...queue.unshuffled.slice(unshuffledAt(queue.unshuffled)),
            ],
            next,
          );

    await saveQueue(ctx, viewer.id, { ...queue, queue: next, unshuffled });

    return ok;
  },

  "queue.remove": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);

    if (args.index >= queue.tracks.length) return fail("invalid_args", "No song at that index");
    const next = queue.queue.filter((_, position) => position !== args.index);

    const remaining = {
      ...queue,
      queue: next,
      unshuffled: queue.unshuffled === undefined ? undefined : restrictTo(queue.unshuffled, next),
    };

    if (args.index < queue.index) {
      await saveQueue(ctx, viewer.id, { ...remaining, index: queue.index - 1 });
    } else if (args.index === queue.index) {
      await saveQueue(ctx, viewer.id, {
        ...remaining,
        index: Math.min(queue.index, Math.max(0, next.length - 1)),
        reportedTrackId: undefined,
      });

      await ctx.db.patch(session._id, {
        positionMs: 0,
        movedAt: Date.now(),
        playing: session.playing && next.length > 0,
        updatedAt: Date.now(),
      });
    } else {
      await saveQueue(ctx, viewer.id, remaining);
    }

    return ok;
  },

  "queue.clear": async (ctx, viewer) => {
    const queue = await loadQueue(ctx, viewer);
    const next = queue.queue.slice(0, queue.index + 1);

    await saveQueue(ctx, viewer.id, {
      ...queue,
      queue: next,
      unshuffled: queue.unshuffled === undefined ? undefined : restrictTo(queue.unshuffled, next),
    });

    return ok;
  },

  "devices.heartbeat": async (ctx, viewer, args) => {
    const existing = await findDevice(ctx, viewer.id, args.deviceId);
    const now = Date.now();

    if (existing === null) {
      await ctx.db.insert("devices", {
        userId: viewer.id,
        deviceId: args.deviceId,
        name: args.name,
        kind: args.kind,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { name: args.name, kind: args.kind, lastSeenAt: now });
    }

    return ok;
  },
} satisfies Partial<MutationHandlers>;
