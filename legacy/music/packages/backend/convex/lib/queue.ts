/**
 * The play queue. Every reader and writer goes through `loadQueue`, which drops songs the viewer
 * can no longer read (their library was deleted or hidden) and moves the index with them.
 *
 * Each entry has its own ID, unique within the queue and never reused, so commands name the entry
 * they mean: a remove or move sent from one device while another device changed the queue still
 * reaches the right row, or fails when that row is gone.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { findSession } from "./playback";
import { canRead } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

type TrackId = Id<"tracks">;

/** One queue entry. */
export interface QueueItem {
  readonly id: string;
  readonly trackId: TrackId;
  /** Who added it; unknown for entries converted from queues stored before entries had IDs. */
  readonly addedBy: Id<"users"> | undefined;
  /** Added by autoplay, not by a person. */
  readonly autoplay: boolean;
}

/** A queue as stored, before the viewer's access is applied. */
export interface StoredQueue {
  readonly items: ReadonlyArray<QueueItem>;
  /** The entry IDs in their order before shuffle, kept while shuffle is on. */
  readonly unshuffled: ReadonlyArray<string> | undefined;
  readonly index: number;
  readonly shuffle: boolean;
  readonly repeat: Doc<"playbackQueues">["repeat"];
  /** The song whose play history last recorded; cleared when a song starts again. */
  readonly reportedTrackId: TrackId | undefined;
  /** The number in the next entry's ID. */
  readonly nextItemId: number;
  readonly autoplay: boolean;
}

/** A queue the viewer may play: every entry is a song they can read. */
export interface Queue extends StoredQueue {
  /** The songs of `items`, in order. */
  readonly tracks: ReadonlyArray<Doc<"tracks">>;
  /** Normalising changed the stored queue, so the next write should save it. */
  readonly stale: boolean;
}

const EMPTY: StoredQueue = {
  items: [],
  unshuffled: undefined,
  index: 0,
  shuffle: false,
  repeat: "off",
  reportedTrackId: undefined,
  nextItemId: 1,
  autoplay: true,
};

const findQueueRow = (ctx: ReadCtx, userId: Id<"users">) =>
  ctx.db
    .query("playbackQueues")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

/**
 * Entries for a queue stored as song IDs, numbered from 1 in play order. The numbering is the same
 * on every read, so an ID a client saw before the queue was first rewritten still names its entry.
 * Each song in the old unshuffled order takes the first entry of that song not yet taken.
 */
export const itemsFromTrackIds = (
  queue: ReadonlyArray<TrackId>,
  unshuffled: ReadonlyArray<TrackId> | undefined,
): Pick<StoredQueue, "items" | "unshuffled" | "nextItemId"> => {
  const items = queue.map((trackId, position): QueueItem => ({
    id: String(position + 1),
    trackId,
    addedBy: undefined,
    autoplay: false,
  }));

  const free = new Map<TrackId, Array<string>>();

  for (const item of items) free.set(item.trackId, [...(free.get(item.trackId) ?? []), item.id]);

  const order = unshuffled?.flatMap((trackId) => {
    const id = free.get(trackId)?.shift();

    return id === undefined ? [] : [id];
  });

  return { items, unshuffled: order, nextItemId: items.length + 1 };
};

/** Whether a session still carries the queue fields older versions stored on it. */
export const hasLegacyQueue = (session: Doc<"playbackSessions">): boolean =>
  session.queue !== undefined ||
  session.unshuffled !== undefined ||
  session.index !== undefined ||
  session.shuffle !== undefined ||
  session.repeat !== undefined ||
  session.reportedTrackId !== undefined;

/** The queue an older version stored on the session. */
export const legacyQueue = (session: Doc<"playbackSessions">): StoredQueue => ({
  ...EMPTY,
  ...itemsFromTrackIds(session.queue ?? [], session.unshuffled),
  index: session.index ?? 0,
  shuffle: session.shuffle ?? false,
  repeat: session.repeat ?? "off",
  reportedTrackId: session.reportedTrackId,
});

/** Whether a `playbackQueues` row still stores song IDs instead of entries. */
export const hasLegacyItems = (row: Doc<"playbackQueues">): boolean =>
  row.items === undefined || row.queue !== undefined || row.unshuffled !== undefined;

/** The queue a `playbackQueues` row holds, in either representation. */
export const rowQueue = (row: Doc<"playbackQueues">): StoredQueue => {
  const entries =
    row.items === undefined
      ? itemsFromTrackIds(row.queue ?? [], row.unshuffled)
      : {
          items: row.items.map((item): QueueItem => ({
            id: item.id,
            trackId: item.trackId,
            addedBy: item.addedBy,
            autoplay: item.autoplay === true,
          })),
          unshuffled: row.unshuffledItems,
          nextItemId: row.nextItemId ?? row.items.length + 1,
        };

  return {
    ...entries,
    index: row.index,
    shuffle: row.shuffle,
    repeat: row.repeat,
    reportedTrackId: row.reportedTrackId,
    autoplay: row.autoplay ?? true,
  };
};

/** Clears the legacy queue fields from a session. */
export const clearedLegacyQueue = {
  queue: undefined,
  unshuffled: undefined,
  index: undefined,
  shuffle: undefined,
  repeat: undefined,
  reportedTrackId: undefined,
} as const;

/**
 * The user's stored queue. It reads the session only for a user whose queue has not moved to its
 * own row yet, so once it has, position reports never re-run a query that reads the queue.
 */
export const storedQueue = async (ctx: ReadCtx, userId: Id<"users">): Promise<StoredQueue> => {
  const row = await findQueueRow(ctx, userId);

  if (row !== null) return rowQueue(row);
  const session = await findSession(ctx, userId);

  return session === null ? EMPTY : legacyQueue(session);
};

/** The position of the entry `itemId`, or null when it is not in the queue. */
export const itemPosition = (queue: StoredQueue, itemId: string): number | null => {
  const position = queue.items.findIndex((item) => item.id === itemId);

  return position === -1 ? null : position;
};

/** Who added new entries, or that autoplay did. */
export type ItemOrigin =
  | { readonly kind: "person"; readonly userId: Id<"users"> }
  | { readonly kind: "autoplay" };

/** Entries just made, and the queue's counter after them. */
export interface NewItems {
  readonly items: ReadonlyArray<QueueItem>;
  readonly nextItemId: number;
}

/** New entries for `trackIds`, numbered on from the queue's counter. */
export const newItems = (
  queue: Pick<StoredQueue, "nextItemId">,
  trackIds: ReadonlyArray<TrackId>,
  origin: ItemOrigin,
): NewItems => ({
  items: trackIds.map((trackId, offset) => ({
    id: String(queue.nextItemId + offset),
    trackId,
    addedBy: origin.kind === "person" ? origin.userId : undefined,
    autoplay: origin.kind === "autoplay",
  })),
  nextItemId: queue.nextItemId + trackIds.length,
});

/**
 * Where songs added "to the end" go: after the entries people queued, before the first upcoming
 * entry autoplay added, so autoplay always plays last.
 */
export const endOfQueued = (queue: StoredQueue): number => {
  const autoplayAt = queue.items.findIndex(
    (item, position) => position > queue.index && item.autoplay,
  );

  return autoplayAt === -1 ? queue.items.length : autoplayAt;
};

/** `order` without the IDs that are no longer entries of `items`. */
export const keptOrder = (
  order: ReadonlyArray<string>,
  items: ReadonlyArray<QueueItem>,
): Array<string> => {
  const present = new Set(items.map((item) => item.id));

  return order.filter((id) => present.has(id));
};

/**
 * Drops the entries `lookup` cannot find and moves the index to the same entry, or to the next one
 * left when that entry was dropped. Pure, so it can be checked on its own.
 */
export const normaliseQueue = (
  stored: StoredQueue,
  lookup: (id: TrackId) => Doc<"tracks"> | null,
): Queue => {
  const found = stored.items.map((item) => lookup(item.trackId));
  const items = stored.items.filter((_, position) => found[position] !== null);
  const tracks = found.filter((track): track is Doc<"tracks"> => track !== null);
  const before = found.slice(0, Math.max(0, stored.index)).filter((track) => track !== null);
  const index = Math.min(before.length, Math.max(0, tracks.length - 1));

  const unshuffled =
    stored.shuffle && stored.unshuffled !== undefined
      ? keptOrder(stored.unshuffled, items)
      : undefined;

  return {
    ...stored,
    items,
    tracks,
    unshuffled,
    index,
    stale:
      items.length !== stored.items.length ||
      index !== stored.index ||
      unshuffled?.length !== stored.unshuffled?.length,
  };
};

/** Loads a stored queue's songs and keeps those `keep` accepts. */
export const normaliseStored = async (
  ctx: ReadCtx,
  stored: StoredQueue,
  keep: (track: Doc<"tracks">) => boolean,
): Promise<Queue> => {
  const ids = [...new Set(stored.items.map((item) => item.trackId))];
  const docs = await Promise.all(ids.map((id) => ctx.db.get(id)));

  const kept = new Map(
    ids.flatMap((id, position) => {
      const track = docs[position] ?? null;

      return track !== null && keep(track) ? [[id, track] as const] : [];
    }),
  );

  return normaliseQueue(stored, (id) => kept.get(id) ?? null);
};

/**
 * The viewer's queue, keeping only songs they can read. A song whose file went missing stays: it
 * may come back, and the player skips it if it can't stream.
 */
export const loadQueue = async (ctx: ReadCtx, viewer: Viewer): Promise<Queue> =>
  normaliseStored(ctx, await storedQueue(ctx, viewer.id), (track) =>
    canRead(viewer, track.libraryId),
  );

const sameOrder = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((id, position) => right[position] === id);

const sameItems = (
  stored: Doc<"playbackQueues">["items"],
  next: ReadonlyArray<QueueItem>,
): boolean =>
  stored !== undefined &&
  stored.length === next.length &&
  stored.every((item, position) => {
    const other = next[position];

    return (
      other !== undefined &&
      item.id === other.id &&
      item.trackId === other.trackId &&
      item.addedBy === other.addedBy &&
      (item.autoplay === true) === other.autoplay
    );
  });

/**
 * Saves the user's queue to its own row, creating it (and clearing the legacy session fields) on
 * the first write. Writes nothing when the row already holds `next`, so readers of the queue only
 * re-run when it changed.
 */
export const saveQueue = async (
  ctx: MutationCtx,
  userId: Id<"users">,
  next: StoredQueue,
): Promise<void> => {
  const fields = {
    // Convex leaves out fields set to `undefined`, so entries store only what they have.
    items: next.items.map((item) => ({
      id: item.id,
      trackId: item.trackId,
      addedBy: item.addedBy,
      autoplay: item.autoplay ? true : undefined,
    })),
    unshuffledItems: next.unshuffled === undefined ? undefined : [...next.unshuffled],
    nextItemId: next.nextItemId,
    autoplay: next.autoplay,
    queue: undefined,
    unshuffled: undefined,
    index: next.index,
    shuffle: next.shuffle,
    repeat: next.repeat,
    reportedTrackId: next.reportedTrackId,
  };

  const row = await findQueueRow(ctx, userId);

  if (row === null) {
    await ctx.db.insert("playbackQueues", { userId, ...fields });
    const session = await findSession(ctx, userId);

    if (session !== null && hasLegacyQueue(session)) {
      await ctx.db.patch(session._id, clearedLegacyQueue);
    }

    return;
  }

  const unchanged =
    !hasLegacyItems(row) &&
    sameItems(row.items, next.items) &&
    sameOrder(row.unshuffledItems, next.unshuffled) &&
    row.nextItemId === next.nextItemId &&
    row.autoplay === next.autoplay &&
    row.index === next.index &&
    row.shuffle === next.shuffle &&
    row.repeat === next.repeat &&
    row.reportedTrackId === next.reportedTrackId;

  if (!unchanged) await ctx.db.patch(row._id, fields);
};
