/**
 * The play queue. Every reader and writer goes through `loadQueue`, which drops songs the viewer
 * can no longer read (their library was deleted or hidden) and moves the index with them, so an
 * index a client sends always means the song that client was shown.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { findSession } from "./playback";
import { canRead } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

type TrackId = Id<"tracks">;

/** A queue as stored, before the viewer's access is applied. */
export interface StoredQueue {
  readonly queue: ReadonlyArray<TrackId>;
  /** The order before shuffle, kept while shuffle is on and restored when it turns off. */
  readonly unshuffled: ReadonlyArray<TrackId> | undefined;
  readonly index: number;
  readonly shuffle: boolean;
  readonly repeat: Doc<"playbackQueues">["repeat"];
  /** The song whose play history last recorded; cleared when a song starts again. */
  readonly reportedTrackId: TrackId | undefined;
}

/** A queue the viewer may play: every entry is a song they can read. */
export interface Queue extends StoredQueue {
  /** The songs of `queue`, in order. */
  readonly tracks: ReadonlyArray<Doc<"tracks">>;
  /** Normalising changed the stored queue, so the next write should save it. */
  readonly stale: boolean;
}

const EMPTY: StoredQueue = {
  queue: [],
  unshuffled: undefined,
  index: 0,
  shuffle: false,
  repeat: "off",
  reportedTrackId: undefined,
};

const findQueueRow = (ctx: ReadCtx, userId: Id<"users">) =>
  ctx.db
    .query("playbackQueues")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

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
  queue: session.queue ?? [],
  unshuffled: session.unshuffled,
  index: session.index ?? 0,
  shuffle: session.shuffle ?? false,
  repeat: session.repeat ?? "off",
  reportedTrackId: session.reportedTrackId,
});

/** The queue a `playbackQueues` row holds. */
export const rowQueue = (row: Doc<"playbackQueues">): StoredQueue => ({
  queue: row.queue,
  unshuffled: row.unshuffled,
  index: row.index,
  shuffle: row.shuffle,
  repeat: row.repeat,
  reportedTrackId: row.reportedTrackId,
});

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

/**
 * The items of `order`, in that order, each kept as many times as it appears in `kept`. Used to
 * keep the unshuffled order in step with the queue: removing a song from the queue removes one
 * copy of it from the unshuffled order too.
 */
export const restrictTo = <Item>(
  order: ReadonlyArray<Item>,
  kept: ReadonlyArray<Item>,
): Array<Item> => {
  const remaining = new Map<Item, number>();

  for (const item of kept) remaining.set(item, (remaining.get(item) ?? 0) + 1);

  return order.filter((item) => {
    const count = remaining.get(item) ?? 0;

    if (count === 0) return false;
    remaining.set(item, count - 1);

    return true;
  });
};

/**
 * Drops the entries `lookup` cannot find and moves the index to the same song, or to the next one
 * left when that song was dropped. Pure, so it can be checked on its own.
 */
export const normaliseQueue = (
  stored: StoredQueue,
  lookup: (id: TrackId) => Doc<"tracks"> | null,
): Queue => {
  const found = stored.queue.map(lookup);
  const tracks = found.filter((track): track is Doc<"tracks"> => track !== null);
  const before = found.slice(0, Math.max(0, stored.index)).filter((track) => track !== null);
  const index = Math.min(before.length, Math.max(0, tracks.length - 1));

  const unshuffled =
    stored.shuffle && stored.unshuffled !== undefined
      ? stored.unshuffled.filter((id) => lookup(id) !== null)
      : undefined;

  return {
    ...stored,
    queue: tracks.map((track) => track._id),
    tracks,
    unshuffled,
    index,
    stale:
      tracks.length !== stored.queue.length ||
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
  const ids = [...new Set([...stored.queue, ...(stored.unshuffled ?? [])])];
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

const sameIds = (
  left: ReadonlyArray<TrackId> | undefined,
  right: ReadonlyArray<TrackId> | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((id, position) => right[position] === id);

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
    queue: [...next.queue],
    unshuffled: next.unshuffled === undefined ? undefined : [...next.unshuffled],
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
    sameIds(row.queue, next.queue) &&
    sameIds(row.unshuffled, next.unshuffled) &&
    row.index === next.index &&
    row.shuffle === next.shuffle &&
    row.repeat === next.repeat &&
    row.reportedTrackId === next.reportedTrackId;

  if (!unchanged) await ctx.db.patch(row._id, fields);
};
