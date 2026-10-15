import type { PlaybackPosition, PlaybackQueue } from "@music/commands/models";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { autoplaySongs } from "../lib/autoplay";
import { DEVICE_LISTED_MS, DEVICE_LIST_LIMIT, listedDevices } from "../lib/devices";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { MAX_QUEUE, ensureSession, findSession, livePosition, shuffled } from "../lib/playback";
import { DEVICE_ONLINE_MS, makeContributors, makePresenter, presentDevice } from "../lib/present";
import {
  endOfQueued,
  itemPosition,
  keptOrder,
  loadQueue,
  newItems,
  normaliseStored,
  saveQueue,
  storedQueue,
} from "../lib/queue";
import type { Queue, QueueItem, StoredQueue } from "../lib/queue";
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

const GONE_MESSAGE = "That song is no longer in the queue";

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
 * Where a reported entry is in the queue. A player sends the entry and the index it was shown;
 * the entry's ID finds it wherever it moved. Players from before entries had IDs send the song
 * instead, and the occurrence nearest the reported index wins. Null when it is gone.
 */
const reportedIndex = (
  queue: StoredQueue,
  index: number,
  report: { readonly trackId: string | undefined; readonly itemId: string | undefined },
): number | null => {
  if (report.itemId !== undefined) return itemPosition(queue, report.itemId);

  if (report.trackId === undefined) return index < queue.items.length ? index : null;

  if (queue.items[index]?.trackId === report.trackId) return index;

  const positions = queue.items.flatMap((item, position) =>
    item.trackId === report.trackId ? [position] : [],
  );

  const [nearest] = positions.toSorted(
    (left, right) => Math.abs(left - index) - Math.abs(right - index),
  );

  return nearest ?? null;
};

/**
 * The queue, and the index and song a position report names. Reports arrive every few seconds,
 * so when the stored queue holds the named entry where the report says (every write saves the
 * queue as the viewer sees it, so this is the usual case) only that song is read. Otherwise, as
 * after a library was deleted, the whole queue is loaded and normalised.
 */
const locateReport = async (
  ctx: MutationCtx,
  viewer: Viewer,
  reported: number,
  report: { readonly trackId: string | undefined; readonly itemId: string | undefined },
): Promise<{
  readonly queue: StoredQueue;
  readonly index: number;
  readonly track: Doc<"tracks">;
} | null> => {
  const stored = await storedQueue(ctx, viewer.id);
  const index = reportedIndex(stored, reported, report);
  const item = index === null ? undefined : stored.items[index];

  if (index !== null && item !== undefined && item.trackId === (report.trackId ?? item.trackId)) {
    const track = await ctx.db.get(item.trackId);

    if (track !== null && canRead(viewer, track.libraryId)) {
      return { queue: stored, index, track };
    }
  }

  const queue = await normaliseStored(ctx, stored, (track) => canRead(viewer, track.libraryId));
  const found = reportedIndex(queue, reported, report);
  const track = found === null ? undefined : queue.tracks[found];

  return found === null || track === undefined ? null : { queue, index: found, track };
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

/**
 * The queue with autoplay songs after it when the entry at `index` is the last one, autoplay is
 * on, and repeat is off: the music goes on, and the player can preload what follows. When the
 * queue is full, the oldest played entries make room.
 */
const toppedUp = async (
  ctx: MutationCtx,
  viewer: Viewer,
  queue: StoredQueue,
): Promise<StoredQueue> => {
  const current = queue.items[queue.index];

  if (
    !queue.autoplay ||
    queue.repeat !== "off" ||
    current === undefined ||
    queue.index < queue.items.length - 1
  ) {
    return queue;
  }

  const seed = await ctx.db.get(current.trackId);

  if (seed === null) return queue;

  const songs = await autoplaySongs(
    ctx,
    viewer,
    seed,
    queue.items.map((item) => item.trackId),
  );

  if (songs.length === 0) return queue;
  const added = newItems(queue, songs, { kind: "autoplay" });
  const overflow = Math.max(0, queue.items.length + added.items.length - MAX_QUEUE);
  const items = [...queue.items, ...added.items].slice(overflow);

  return {
    ...queue,
    items,
    index: queue.index - overflow,
    nextItemId: added.nextItemId,
    unshuffled:
      queue.unshuffled === undefined
        ? undefined
        : keptOrder([...queue.unshuffled, ...added.items.map((item) => item.id)], items),
  };
};

/**
 * Saves a queue changed by hand, topped up with autoplay when the current entry is now the last,
 * so the player always has a next song to preload.
 */
const saveTopped = async (ctx: MutationCtx, viewer: Viewer, queue: StoredQueue): Promise<void> => {
  await saveQueue(ctx, viewer.id, await toppedUp(ctx, viewer, queue));
};

/**
 * The unshuffled order with `itemId` moved after `afterItemId` there too (or to the top), so a
 * move made while shuffled still holds once shuffle turns off.
 */
const movedInOrder = (
  order: ReadonlyArray<string>,
  itemId: string,
  afterItemId: string | undefined,
): Array<string> => {
  const rest = order.filter((id) => id !== itemId);
  const after = afterItemId === undefined ? -1 : rest.indexOf(afterItemId);

  return [...rest.slice(0, after + 1), itemId, ...rest.slice(after + 1)];
};

/** Removes the upcoming entries autoplay added, for when autoplay turns off. */
const withoutAutoplay = (queue: StoredQueue): StoredQueue => {
  const items = queue.items.filter((item, position) => position <= queue.index || !item.autoplay);

  return {
    ...queue,
    items,
    unshuffled: queue.unshuffled === undefined ? undefined : keptOrder(queue.unshuffled, items),
  };
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

/** The entries of a loaded queue as clients see them. */
const presentQueue = async (
  ctx: ReadCtx,
  viewer: Viewer,
  queue: Queue,
): Promise<(typeof PlaybackQueue)["Encoded"]> => {
  const present = makePresenter(ctx, viewer);
  const contributor = makeContributors(ctx);

  const entries = queue.items.flatMap((item, position) => {
    const track = queue.tracks[position];

    return track === undefined ? [] : [{ item, track }];
  });

  return {
    queue: await Promise.all(
      entries.map(async ({ item, track }) =>
        // The presented track is a new object made for this entry.
        Object.assign(await present.track(track), {
          itemId: item.id,
          addedBy: item.addedBy === undefined ? null : await contributor(item.addedBy),
          autoplay: item.autoplay,
        }),
      ),
    ),
    index: queue.index,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    autoplay: queue.autoplay,
  };
};

/** The queue the viewer may play. Reads neither the session nor its device. */
const queueOf = async (ctx: ReadCtx, viewer: Viewer): Promise<(typeof PlaybackQueue)["Encoded"]> =>
  presentQueue(ctx, viewer, await loadQueue(ctx, viewer));

/** Marks that a command moved playback to another song, from its start. */
const restartSession = async (
  ctx: MutationCtx,
  session: Doc<"playbackSessions">,
  fields: { readonly playing?: boolean; readonly activeDeviceId?: string | undefined } = {},
): Promise<void> => {
  const now = Date.now();

  await ctx.db.patch(session._id, { positionMs: 0, updatedAt: now, movedAt: now, ...fields });
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
    const created = newItems(stored, playable.ids, { kind: "person", userId: viewer.id });
    let items: ReadonlyArray<QueueItem> = created.items;
    let { index } = playable;
    let unshuffled: ReadonlyArray<string> | undefined;

    if (stored.shuffle) {
      // Shuffle the whole list, then keep `MAX_QUEUE` of it: a long list shuffled from a random
      // song near its end still fills the queue.
      const current = items[index];
      const rest = shuffled(items.filter((_, position) => position !== index));
      const kept = (current === undefined ? rest : [current, ...rest]).slice(0, MAX_QUEUE);
      unshuffled = keptOrder(
        items.map((item) => item.id),
        kept,
      );
      items = kept;
      index = 0;
    } else if (items.length > MAX_QUEUE) {
      items = items.slice(index, index + MAX_QUEUE);
      index = 0;
    }

    const next = await toppedUp(ctx, viewer, {
      ...stored,
      items,
      unshuffled,
      index,
      nextItemId: created.nextItemId,
      reportedTrackId: undefined,
    });

    await saveQueue(ctx, viewer.id, next);

    await restartSession(ctx, session, {
      playing: true,
      activeDeviceId: args.deviceId ?? (await defaultDevice(ctx, viewer, session)),
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

    if (queue.items.length === 0) return fail("conflict", "The queue is empty");
    await saveQueue(ctx, viewer.id, queue);
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, { playing: true, updatedAt: Date.now(), activeDeviceId });

    return ok;
  },

  "playback.next": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    // Whatever comes next starts from the top, so it counts as a new play.
    const queue = { ...(await loadQueue(ctx, viewer)), reportedTrackId: undefined };
    const last = queue.items.length - 1;

    if (queue.index < last) {
      await saveQueue(
        ctx,
        viewer.id,
        await toppedUp(ctx, viewer, { ...queue, index: queue.index + 1 }),
      );
      await restartSession(ctx, session);

      return ok;
    }

    if (queue.repeat === "all" && queue.items.length > 0) {
      await saveQueue(ctx, viewer.id, { ...queue, index: 0 });
      await restartSession(ctx, session);

      return ok;
    }

    // The queue ran out: autoplay keeps going when it finds something; otherwise playback stops.
    const extended = await toppedUp(ctx, viewer, queue);

    if (extended.index < extended.items.length - 1) {
      await saveQueue(ctx, viewer.id, { ...extended, index: extended.index + 1 });
      await restartSession(ctx, session);

      return ok;
    }

    await saveQueue(ctx, viewer.id, queue);
    await restartSession(ctx, session, { playing: false });

    return ok;
  },

  "playback.previous": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const position = livePosition(session, Date.now());

    const index =
      position > RESTART_THRESHOLD_MS
        ? queue.index
        : queue.index > 0
          ? queue.index - 1
          : queue.repeat === "all"
            ? Math.max(0, queue.items.length - 1)
            : 0;

    await saveQueue(ctx, viewer.id, { ...queue, index, reportedTrackId: undefined });
    await restartSession(ctx, session);

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
    const index = itemPosition(queue, args.itemId);

    if (index === null) return fail("not_found", GONE_MESSAGE);

    await saveQueue(
      ctx,
      viewer.id,
      await toppedUp(ctx, viewer, { ...queue, index, reportedTrackId: undefined }),
    );

    await restartSession(ctx, session, {
      playing: true,
      activeDeviceId: await defaultDevice(ctx, viewer, session),
    });

    return ok;
  },

  "playback.shuffle": async (ctx, viewer, args) => {
    const queue = await loadQueue(ctx, viewer);

    if (args.on === queue.shuffle) {
      await saveQueue(ctx, viewer.id, queue);

      return ok;
    }

    const current = queue.items[queue.index];

    if (args.on) {
      // People's songs are shuffled; autoplay's stay after them, so autoplay still plays last.
      const others = queue.items.filter((_, position) => position !== queue.index);

      const rest = [
        ...shuffled(others.filter((item) => !item.autoplay)),
        ...others.filter((item) => item.autoplay),
      ];

      await saveQueue(ctx, viewer.id, {
        ...queue,
        shuffle: true,
        unshuffled: queue.items.map((item) => item.id),
        items: current === undefined ? rest : [current, ...rest],
        index: 0,
      });

      return ok;
    }

    // Back to the order before shuffle; entries it does not list (none, normally) go at the end.
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    const order = keptOrder(queue.unshuffled ?? [], queue.items);
    const listed = new Set(order);

    const items = [
      ...order.flatMap((id) => {
        const item = byId.get(id);

        return item === undefined ? [] : [item];
      }),
      ...queue.items.filter((item) => !listed.has(item.id)),
    ];

    const index = current === undefined ? 0 : items.findIndex((item) => item.id === current.id);

    await saveQueue(ctx, viewer.id, {
      ...queue,
      shuffle: false,
      unshuffled: undefined,
      items,
      index: Math.max(0, index),
    });

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

    const located = await locateReport(ctx, viewer, args.index, {
      trackId: args.trackId,
      itemId: args.itemId,
    });

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

    const moved = {
      ...queue,
      index,
      reportedTrackId: newPlay ? track._id : queue.reportedTrackId,
    };

    // The player moved on by itself (the last song started): autoplay fills in what follows.
    await saveQueue(
      ctx,
      viewer.id,
      index === queue.index ? moved : await toppedUp(ctx, viewer, moved),
    );

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
    const songs = (await playableTracks(ctx, viewer, args.trackIds)).ids;
    const created = newItems(queue, songs, { kind: "person", userId: viewer.id });

    if (queue.items.length === 0) {
      const items = created.items.slice(0, MAX_QUEUE);

      await saveTopped(ctx, viewer, {
        ...queue,
        items,
        nextItemId: created.nextItemId,
        unshuffled: queue.shuffle ? items.map((item) => item.id) : undefined,
        index: 0,
        reportedTrackId: undefined,
      });

      await restartSession(ctx, session, { playing: false });

      return { ok: true, itemIds: items.map((item) => item.id) } as const;
    }

    const insertAt = args.next === true ? queue.index + 1 : endOfQueued(queue);

    const items = [
      ...queue.items.slice(0, insertAt),
      ...created.items,
      ...queue.items.slice(insertAt),
    ].slice(0, MAX_QUEUE);

    // Added songs join the unshuffled order too, after the current song or at the end, so
    // turning shuffle off keeps them.
    const current = queue.items[queue.index];
    const addedIds = created.items.map((item) => item.id);

    const unshuffledAt = (order: ReadonlyArray<string>): number =>
      args.next === true && current !== undefined ? order.indexOf(current.id) + 1 : order.length;

    const unshuffled =
      queue.unshuffled === undefined
        ? undefined
        : keptOrder(
            [
              ...queue.unshuffled.slice(0, unshuffledAt(queue.unshuffled)),
              ...addedIds,
              ...queue.unshuffled.slice(unshuffledAt(queue.unshuffled)),
            ],
            items,
          );

    await saveTopped(ctx, viewer, {
      ...queue,
      items,
      unshuffled,
      nextItemId: created.nextItemId,
    });

    const kept = new Set(items.map((item) => item.id));

    return { ok: true, itemIds: addedIds.filter((id) => kept.has(id)) } as const;
  },

  "queue.remove": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const position = itemPosition(queue, args.itemId);

    if (position === null) return fail("not_found", GONE_MESSAGE);
    const items = queue.items.filter((item) => item.id !== args.itemId);

    const remaining = {
      ...queue,
      items,
      unshuffled: queue.unshuffled === undefined ? undefined : keptOrder(queue.unshuffled, items),
    };

    if (position < queue.index) {
      await saveTopped(ctx, viewer, { ...remaining, index: queue.index - 1 });
    } else if (position === queue.index) {
      await saveTopped(ctx, viewer, {
        ...remaining,
        index: Math.min(queue.index, Math.max(0, items.length - 1)),
        reportedTrackId: undefined,
      });

      await restartSession(ctx, session, { playing: session.playing && items.length > 0 });
    } else {
      await saveTopped(ctx, viewer, remaining);
    }

    return ok;
  },

  "queue.move": async (ctx, viewer, args) => {
    const queue = await loadQueue(ctx, viewer);
    const from = itemPosition(queue, args.itemId);
    const moving = from === null ? undefined : queue.items[from];

    if (moving === undefined) return fail("not_found", GONE_MESSAGE);

    if (args.afterItemId === args.itemId) {
      return fail("invalid_args", "An entry can't move after itself");
    }

    const rest = queue.items.filter((item) => item.id !== args.itemId);

    const after =
      args.afterItemId === undefined ? -1 : rest.findIndex((item) => item.id === args.afterItemId);

    // The entry it should follow was removed meanwhile; moving anyway would guess the place.
    if (after === -1 && args.afterItemId !== undefined) return fail("not_found", GONE_MESSAGE);

    const items = [...rest.slice(0, after + 1), moving, ...rest.slice(after + 1)];
    const current = queue.items[queue.index];
    const index = current === undefined ? 0 : items.findIndex((item) => item.id === current.id);

    // The playing entry stays the same, so the session is untouched.
    await saveTopped(ctx, viewer, {
      ...queue,
      items,
      index: Math.max(0, index),
      unshuffled:
        queue.unshuffled === undefined
          ? undefined
          : movedInOrder(queue.unshuffled, args.itemId, args.afterItemId),
    });

    return ok;
  },

  "queue.clear": async (ctx, viewer) => {
    const queue = await loadQueue(ctx, viewer);
    const items = queue.items.slice(0, queue.index + 1);

    await saveTopped(ctx, viewer, {
      ...queue,
      items,
      unshuffled: queue.unshuffled === undefined ? undefined : keptOrder(queue.unshuffled, items),
    });

    return ok;
  },

  "queue.autoplay": async (ctx, viewer, args) => {
    const queue = { ...(await loadQueue(ctx, viewer)), autoplay: args.on };

    await saveQueue(
      ctx,
      viewer.id,
      args.on ? await toppedUp(ctx, viewer, queue) : withoutAutoplay(queue),
    );

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
