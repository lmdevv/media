import type {
  OfflinePlay,
  OfflineResume,
  PlaybackPosition,
  PlaybackQueue,
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

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { autoplaySongs } from "../lib/autoplay";
import { DEVICE_LISTED_MS, DEVICE_LIST_LIMIT, listedDevices } from "../lib/devices";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { ensureSession, findSession, livePosition } from "../lib/playback";
import { DEVICE_ONLINE_MS, makeContributors, makePresenter, presentDevice } from "../lib/present";
import {
  itemPosition,
  loadQueue,
  newItems,
  normaliseStored,
  saveQueue,
  storedQueue,
} from "../lib/queue";
import type { Queue, QueueItem, StoredQueue } from "../lib/queue";
import {
  hostedJam,
  jamAutoplayViewer,
  jamShareableEntry,
  listenAlong,
  requireAdds,
  requireControl,
  requireEdit,
  requireHost,
  resolvePlayback,
} from "../lib/jams";
import type { Playback } from "../lib/jams";
import { canRead } from "../lib/viewer";
import type { ReadCtx, Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

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

/** Fails unless the host (`owner`) can play every one of `songs`. */
const requireHostCanPlay = async (
  ctx: MutationCtx,
  owner: Viewer,
  songs: ReadonlyArray<Id<"tracks">>,
): Promise<void> => {
  const docs = await Promise.all(songs.map((id) => ctx.db.get(id)));
  const unplayable = docs.find((doc) => doc !== null && !canRead(owner, doc.libraryId));

  if (unplayable !== undefined && unplayable !== null) {
    fail("forbidden", `${unplayable.title} is in a library the host can't play`);
  }
};

/** Picks the device that should play when the caller did not name one. */
const defaultDevice = async (
  ctx: MutationCtx,
  viewer: Viewer,
  session: Doc<"playbackSessions">,
): Promise<string | undefined> => {
  const now = Date.now();

  // Only online devices can take playback, so only their range is read: every browser that ever
  // opened the app keeps a device row for a month.
  const online = await ctx.db
    .query("devices")
    .withIndex("by_user_last_seen", (q) =>
      q.eq("userId", viewer.id).gt("lastSeenAt", now - DEVICE_ONLINE_MS),
    )
    .collect();

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

  const [seed, jam] = await Promise.all([ctx.db.get(current.trackId), hostedJam(ctx, viewer.id)]);

  if (seed === null) return queue;

  const songs = await autoplaySongs(
    ctx,
    // In a Jam, autoplay's songs go to everyone in it: never from a library granted only to the
    // host (`jamShareable`). The host's own adds are their choice.
    jam === null ? viewer : jamAutoplayViewer(viewer),
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
 * Picks autoplay's upcoming songs again for a host who just started a Jam: ones chosen before
 * may come from libraries granted to the host alone, which the Jam must not share.
 */
export const refreshJamAutoplay = async (ctx: MutationCtx, host: Viewer): Promise<void> => {
  const before = await loadQueue(ctx, host);

  if (before.items.some((item, position) => position > before.index && item.autoplay)) {
    await saveTopped(ctx, host, { ...before, ...withoutUpcomingAutoplay(before) });
  }

  // A song autoplay picked from a library shared with the host alone may be playing: move on to
  // the next one the Jam may share, so people listening along have something to play.
  const queue = await loadQueue(ctx, host);
  const current = queue.items[queue.index];
  const currentTrack = queue.tracks[queue.index];

  if (current === undefined || currentTrack === undefined) return;

  if (jamShareableEntry(host, current, currentTrack)) return;

  const next = queue.items.findIndex((item, position) => {
    const track = queue.tracks[position];

    return position > queue.index && track !== undefined && jamShareableEntry(host, item, track);
  });

  const session = await findSession(ctx, host.id);

  if (next === -1) {
    if (session !== null)
      await ctx.db.patch(session._id, { playing: false, updatedAt: Date.now() });

    return;
  }

  await saveTopped(ctx, host, { ...queue, index: next, reportedTrackId: undefined });

  if (session !== null) await restartSession(ctx, session);
};

/**
 * Saves a queue changed by hand, topped up with autoplay when the current entry is now the last,
 * so the player always has a next song to preload.
 */
const saveTopped = async (ctx: MutationCtx, viewer: Viewer, queue: StoredQueue): Promise<void> => {
  await saveQueue(ctx, viewer.id, await toppedUp(ctx, viewer, queue));
};

/** The device someone in a Jam listens along on, when they do and the host allows it. */
const followingDevice = (playback: Playback): string | null =>
  playback.kind === "member" &&
  playback.jam.settings.listenAlong &&
  playback.member.listening &&
  playback.member.deviceId !== undefined
    ? playback.member.deviceId
    : null;

/**
 * The session's device, position, and volume; the host's in someone else's Jam. A person in
 * someone else's Jam keeps their own volume, which `playback.volume` changes; listening along,
 * they also get their own device and `following`. Reads only the sessions and the device.
 */
const positionFor = async (
  ctx: ReadCtx,
  actor: Viewer,
  playback: Playback,
): Promise<(typeof PlaybackPosition)["Encoded"]> => {
  const owner = playback.owner;
  const session = await findSession(ctx, owner.id);
  const following = followingDevice(playback);

  if (session === null) {
    return {
      activeDevice: null,
      positionMs: 0,
      playing: false,
      updatedAt: 0,
      volume: 1,
      following: false,
    };
  }

  const [device, own] = await Promise.all([
    following !== null
      ? findDevice(ctx, actor.id, following)
      : session.activeDeviceId === undefined
        ? null
        : findDevice(ctx, owner.id, session.activeDeviceId),
    playback.kind === "member" ? findSession(ctx, actor.id) : null,
  ]);

  return {
    activeDevice: device === null ? null : presentDevice(device, Date.now()),
    positionMs: session.positionMs,
    playing: session.playing,
    updatedAt: session.updatedAt,
    volume: playback.kind === "member" ? (own?.volume ?? 1) : session.volume,
    // A device not registered yet (a first visit from a Jam link) follows once its first
    // heartbeat lands; until then nothing here plays.
    following: following !== null && device !== null,
  };
};

/** The entries of a loaded queue as clients see them. */
/**
 * A queue entry people in a Jam may not know about (`jamShareableEntry`): its place, length, and
 * entry ID, and nothing about the song; the song, album, and artist IDs name only the entry.
 */
const withheldEntry = (
  item: QueueItem,
  track: Doc<"tracks">,
): (typeof PlaybackQueue)["Encoded"]["queue"][number] => ({
  id: `withheld-${item.id}`,
  title: "",
  artist: "",
  artistId: `withheld-${item.id}`,
  album: "",
  albumId: `withheld-${item.id}`,
  trackNumber: null,
  discNumber: null,
  durationMs: track.durationMs,
  codec: "",
  lossless: false,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
  liked: false,
  itemId: item.id,
  addedBy: null,
  autoplay: true,
  withheld: true,
});

/**
 * A queue as `viewer` sees it. `jamHost` is set when they read someone else's Jam: then autoplay's
 * picks from a library shared with the host alone show as withheld entries.
 */
const presentQueue = async (
  ctx: ReadCtx,
  viewer: Viewer,
  queue: Queue,
  jamHost: Viewer | null,
): Promise<(typeof PlaybackQueue)["Encoded"]> => {
  const present = makePresenter(ctx, viewer);
  const contributor = makeContributors(ctx);

  const entries = queue.items.flatMap((item, position) => {
    const track = queue.tracks[position];

    return track === undefined ? [] : [{ item, track }];
  });

  const shared = entries.map(
    ({ item, track }) => jamHost === null || jamShareableEntry(jamHost, item, track),
  );

  // The songs shown are presented together, so a long queue looks the viewer's likes up in one
  // read (see `tracks`); withheld entries are never presented.
  const presented = await present.tracks(
    entries.flatMap(({ track }, position) => (shared[position] === true ? [track] : [])),
  );

  // Where each shown entry's song is in `presented`.
  const slots: Array<number> = [];
  let shownBefore = 0;

  for (const isShared of shared) {
    slots.push(shownBefore);

    if (isShared) shownBefore += 1;
  }

  return {
    queue: await Promise.all(
      entries.map(async ({ item, track }, position) => {
        const shown = shared[position] === true ? presented[slots[position] ?? -1] : undefined;

        return shown === undefined
          ? withheldEntry(item, track)
          : // The presented track is a new object made for this entry.
            Object.assign(shown, {
              itemId: item.id,
              addedBy: item.addedBy === undefined ? null : await contributor(item.addedBy),
              autoplay: item.autoplay,
            });
      }),
    ),
    index: queue.index,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    autoplay: queue.autoplay,
  };
};

/**
 * The queue the viewer plays: their own, or the host's in someone else's Jam (with the host's
 * songs, readable or not: the host chose to play them). Reads neither session nor device.
 */
const queueFor = async (
  ctx: ReadCtx,
  actor: Viewer,
  playback: Playback,
): Promise<(typeof PlaybackQueue)["Encoded"]> =>
  presentQueue(
    ctx,
    actor,
    await loadQueue(ctx, playback.owner),
    playback.kind === "member" ? playback.owner : null,
  );

/** Marks that a command moved playback to another song, from its start. */
const restartSession = async (
  ctx: MutationCtx,
  session: Doc<"playbackSessions">,
  fields: { readonly playing?: boolean; readonly activeDeviceId?: string | undefined } = {},
): Promise<void> => {
  const now = Date.now();

  await ctx.db.patch(session._id, { positionMs: 0, updatedAt: now, movedAt: now, ...fields });
};

/**
 * How many of the viewer's latest plays are checked for ones a device already handed back, so a
 * device that sends its offline plays again (its first call's answer was lost) records them once.
 */
const RECENT_PLAYS_CHECKED = 500;

const playKey = (trackId: Id<"tracks">, playedAt: number): string => `${trackId}@${playedAt}`;

/**
 * The songs among `ids` that exist and the viewer may read, by the ID as given. IDs that name no
 * song are left out rather than failing: a device that played offline may name songs removed or
 * hidden since.
 */
const readableById = async (
  ctx: ReadCtx,
  viewer: Viewer,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Doc<"tracks">>> => {
  const parsed = [...new Set(ids)].flatMap((id) => {
    const trackId = ctx.db.normalizeId("tracks", id);

    return trackId === null ? [] : [[id, trackId] as const];
  });

  const tracks = await Promise.all(parsed.map(([, trackId]) => ctx.db.get(trackId)));

  return new Map(
    parsed.flatMap(([id], position) => {
      const track = tracks[position] ?? null;

      return track !== null && canRead(viewer, track.libraryId) ? [[id, track] as const] : [];
    }),
  );
};

/**
 * Records the plays a device made offline, in the order given, at the times it played them.
 * Songs the viewer can't read are skipped, and so is a play history already holds from the same
 * device for the same song at the same time.
 */
const recordOfflinePlays = async (
  ctx: MutationCtx,
  viewer: Viewer,
  deviceId: string,
  plays: ReadonlyArray<OfflinePlay>,
): Promise<void> => {
  const [recent, tracks] = await Promise.all([
    ctx.db
      .query("history")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .order("desc")
      .take(RECENT_PLAYS_CHECKED),
    readableById(
      ctx,
      viewer,
      plays.map((play) => play.trackId),
    ),
  ]);

  const recorded = new Set(
    recent.flatMap((play) =>
      play.deviceId === deviceId && play.playedAt !== undefined
        ? [playKey(play.trackId, play.playedAt)]
        : [],
    ),
  );

  // Keyed the same way, so a play the batch lists twice is recorded once, where it first appears.
  const offered = new Map(
    plays.flatMap((play) => {
      const track = tracks.get(play.trackId);

      return track === undefined
        ? []
        : [[playKey(track._id, play.playedAt), { track, playedAt: play.playedAt }] as const];
    }),
  );

  await Promise.all(
    [...offered].flatMap(([key, { track, playedAt }]) =>
      recorded.has(key)
        ? []
        : [
            ctx.db.insert("history", {
              userId: viewer.id,
              trackId: track._id,
              albumId: track.albumId,
              deviceId,
              playedAt,
            }),
          ],
    ),
  );
};

/** A device's offline queue as the server's entries, and where it stands in them. */
interface ResumedQueue {
  readonly items: ReadonlyArray<QueueItem>;
  readonly index: number;
  readonly nextItemId: number;
  /** The entry that played on the device is still in the queue; otherwise `index` is the next. */
  readonly current: boolean;
}

/**
 * A device's offline queue as server entries. Songs that name nothing, that the viewer can't
 * read, or whose file is missing drop out, and `index` moves to the same entry or the next one
 * kept. An entry the stored queue still holds under the same ID and song stays as it is, with who
 * added it and whether autoplay did; the others become new entries the viewer added.
 */
const resumedQueue = async (
  ctx: ReadCtx,
  viewer: Viewer,
  stored: StoredQueue,
  resume: OfflineResume,
): Promise<ResumedQueue> => {
  const readable = await readableById(
    ctx,
    viewer,
    resume.items.map((entry) => entry.trackId),
  );

  const held = new Map(stored.items.map((item) => [item.id, item]));
  const items: Array<QueueItem> = [];
  const kept: Array<boolean> = [];
  let nextItemId = stored.nextItemId;

  for (const entry of resume.items) {
    const track = readable.get(entry.trackId);
    const same = held.get(entry.itemId);

    kept.push(track !== undefined && !track.missing);

    if (track === undefined || track.missing) continue;

    if (same?.trackId === track._id) {
      items.push(same);
      // An ID the device lists twice names one entry; the second becomes a new one.
      held.delete(same.id);
      continue;
    }

    items.push({ id: String(nextItemId), trackId: track._id, addedBy: viewer.id, autoplay: false });
    nextItemId += 1;
  }

  const before = kept.slice(0, resume.index).filter(Boolean).length;

  return {
    items,
    index: Math.min(before, Math.max(0, items.length - 1)),
    nextItemId,
    current: kept[resume.index] === true,
  };
};

export const playbackQueries = {
  "playback.state": async (ctx, viewer) => {
    // Resolved once for both halves: for someone in a Jam it reads the host and their libraries.
    const playback = await resolvePlayback(ctx, viewer);

    const [position, queue] = await Promise.all([
      positionFor(ctx, viewer, playback),
      queueFor(ctx, viewer, playback),
    ]);

    return { ...position, ...queue };
  },

  "playback.position": async (ctx, viewer) =>
    positionFor(ctx, viewer, await resolvePlayback(ctx, viewer)),

  "queue.list": async (ctx, viewer) => queueFor(ctx, viewer, await resolvePlayback(ctx, viewer)),

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
  "playback.play": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireHost(playback, "In a Jam, add songs to the queue instead of replacing it");
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    if (args.deviceId !== undefined && (await findDevice(ctx, viewer.id, args.deviceId)) === null) {
      return fail("not_found", "That device is not registered");
    }

    const session = await ensureSession(ctx, viewer.id);
    const stored = await storedQueue(ctx, viewer.id);
    const playable = await playableTracks(ctx, viewer, args.trackIds, args.index);
    const created = newItems(stored, playable.ids, { kind: "person", userId: viewer.id });

    const next = await toppedUp(ctx, viewer, {
      ...stored,
      ...playOrder(created.items, playable.index, stored.shuffle, Math.random),
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

  "playback.pause": async (ctx, actor) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      positionMs: livePosition(session, now),
      playing: false,
      updatedAt: now,
    });

    return ok;
  },

  "playback.resume": async (ctx, actor) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);

    if (queue.items.length === 0) return fail("conflict", "The queue is empty");
    await saveQueue(ctx, viewer.id, queue);
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, { playing: true, updatedAt: Date.now(), activeDeviceId });

    return ok;
  },

  "playback.next": async (ctx, actor) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    // Whatever comes next starts from the top, so it counts as a new play.
    const queue = { ...(await loadQueue(ctx, viewer)), reportedTrackId: undefined };
    const index = nextIndex(queue.index, queue.items.length, queue.repeat);

    // `toppedUp` leaves a repeat-all queue alone, so wrapping to the start never adds autoplay.
    if (index !== null) {
      await saveQueue(ctx, viewer.id, await toppedUp(ctx, viewer, { ...queue, index }));
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

  "playback.previous": async (ctx, actor) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);

    const index = previousIndex(
      livePosition(session, Date.now()),
      queue.index,
      queue.items.length,
      queue.repeat,
    );

    await saveQueue(ctx, viewer.id, { ...queue, index, reportedTrackId: undefined });
    await restartSession(ctx, session);

    return ok;
  },

  "playback.seek": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { positionMs: args.positionMs, updatedAt: Date.now() });

    return ok;
  },

  "playback.jump": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

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

  "playback.shuffle": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const queue = await loadQueue(ctx, viewer);

    if (args.on === queue.shuffle) {
      await saveQueue(ctx, viewer.id, queue);

      return ok;
    }

    await saveQueue(ctx, viewer.id, {
      ...queue,
      shuffle: args.on,
      ...(args.on ? shuffledOn(queue, Math.random) : shuffledOff(queue)),
    });

    return ok;
  },

  "playback.repeat": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireControl(playback);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

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
    const playback = await resolvePlayback(ctx, viewer);

    // In someone else's Jam, "play on" picks the device that listens along.
    if (playback.kind === "member") {
      await listenAlong(ctx, playback.jam, playback.member, device.deviceId);

      return ok;
    }

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
    // A device listening along to someone else's Jam follows the host's device, which reports.
    if ((await resolvePlayback(ctx, viewer)).kind === "member") return ok;
    const session = await ensureSession(ctx, viewer.id);

    if (session.activeDeviceId !== args.deviceId) return ok;

    const located = await locateReport(ctx, viewer, args.index, {
      trackId: args.trackId,
      itemId: args.itemId,
    });

    if (located === null) return ok;
    const { queue, index, track } = located;
    const now = Date.now();

    if (isStaleReport(index, queue.index, session.movedAt ?? null, now)) return ok;

    const newPlay = isNewPlay(
      { trackId: track._id, positionMs: args.positionMs, playing: args.playing },
      { trackId: queue.reportedTrackId ?? null, livePositionMs: livePosition(session, now) },
      track.durationMs,
    );

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

  "queue.add": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    requireAdds(playback, queue, args.trackIds.length);
    // People add songs they can read themselves, also to a Jam; there, the host must be able to
    // play them too, or the entry would sit hidden in the host's queue.
    const songs = (await playableTracks(ctx, actor, args.trackIds)).ids;

    if (playback.kind === "member") await requireHostCanPlay(ctx, viewer, songs);
    const created = newItems(queue, songs, { kind: "person", userId: actor.id });

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

    const order = addedOrder(queue, created.items, args.next === true ? "next" : "end");
    await saveTopped(ctx, viewer, { ...queue, ...order, nextItemId: created.nextItemId });
    const kept = new Set(order.items.map((item) => item.id));

    return {
      ok: true,
      itemIds: created.items.flatMap((item) => (kept.has(item.id) ? [item.id] : [])),
    } as const;
  },

  "queue.remove": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const session = await ensureSession(ctx, viewer.id);
    const queue = await loadQueue(ctx, viewer);
    const position = itemPosition(queue, args.itemId);

    if (position === null) return fail("not_found", GONE_MESSAGE);
    requireEdit(playback, queue.items[position]);
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

  "queue.move": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const queue = await loadQueue(ctx, viewer);
    const from = itemPosition(queue, args.itemId);
    const moving = from === null ? undefined : queue.items[from];

    if (moving === undefined) return fail("not_found", GONE_MESSAGE);
    requireEdit(playback, moving);

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

    // A played song moved back to come up again counts as adding it, within the host's limit.
    if (from !== null && from < queue.index && items.indexOf(moving) > index) {
      requireAdds(playback, queue, 1);
    }

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

  "queue.clear": async (ctx, actor) => {
    const playback = await resolvePlayback(ctx, actor);
    requireHost(playback, "Only the host clears the queue in a Jam");
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const queue = await loadQueue(ctx, viewer);
    const items = queue.items.slice(0, queue.index + 1);

    await saveTopped(ctx, viewer, {
      ...queue,
      items,
      unshuffled: queue.unshuffled === undefined ? undefined : keptOrder(queue.unshuffled, items),
    });

    return ok;
  },

  "queue.autoplay": async (ctx, actor, args) => {
    const playback = await resolvePlayback(ctx, actor);
    requireHost(playback, "Only the host turns autoplay on or off in a Jam");
    // The session and queue acted on: the host's in someone else's Jam.
    const viewer = playback.owner;

    const queue = { ...(await loadQueue(ctx, viewer)), autoplay: args.on };

    await saveQueue(
      ctx,
      viewer.id,
      args.on
        ? await toppedUp(ctx, viewer, queue)
        : { ...queue, ...withoutUpcomingAutoplay(queue) },
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

  "devices.reconcile": async (ctx, viewer, args) => {
    await recordOfflinePlays(ctx, viewer, args.deviceId, args.plays);

    // In someone else's Jam the session is the host's, not this device's to hand back.
    if ((await resolvePlayback(ctx, viewer)).kind === "member") return { adopted: false };
    const { resume } = args;

    if (resume === null || (await findDevice(ctx, viewer.id, args.deviceId)) === null) {
      return { adopted: false };
    }

    const session = await ensureSession(ctx, viewer.id);

    // When another device took over meanwhile, a paused device leaves playback there; a playing
    // one takes it back.
    if (session.activeDeviceId !== args.deviceId && !resume.playing) return { adopted: false };
    const stored = await storedQueue(ctx, viewer.id);
    const resumed = await resumedQueue(ctx, viewer, stored, resume);

    // A queue none of whose songs can play here is not handed back; one emptied there is.
    if (resumed.items.length === 0 && resume.items.length > 0) return { adopted: false };
    const order = playOrder(resumed.items, resumed.index, false, Math.random);

    // While shuffled, the entries the server knew keep their order from before shuffle.
    const known = resume.shuffle ? keptOrder(stored.unshuffled ?? [], order.items) : [];
    const listed = new Set(known);

    await saveTopped(ctx, viewer, {
      ...stored,
      ...order,
      unshuffled: resume.shuffle
        ? [...known, ...order.items.flatMap((item) => (listed.has(item.id) ? [] : [item.id]))]
        : undefined,
      shuffle: resume.shuffle,
      repeat: resume.repeat,
      autoplay: resume.autoplay,
      nextItemId: resumed.nextItemId,
      // The device counted the current song's play offline; a song that took its place has not
      // played yet.
      reportedTrackId: resumed.current ? order.items[order.index]?.trackId : undefined,
    });

    const now = Date.now();

    await ctx.db.patch(session._id, {
      activeDeviceId: args.deviceId,
      positionMs: resumed.current ? resume.positionMs : 0,
      playing: resume.playing && order.items.length > 0,
      volume: resume.volume,
      updatedAt: now,
      movedAt: now,
    });

    return { adopted: true };
  },
} satisfies Partial<MutationHandlers>;
