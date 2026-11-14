import type { Doc } from "../_generated/dataModel";
import { inOrder } from "../core/lib/inOrder";
import { CALL_COST, sumCost, whileBudget } from "./budget";
import type { Cost } from "./budget";
import type { MusicStore } from "./write";
import { atBound } from "./write";

/**
 * What people keep of a track that a purge deletes, as old music's purge did before it deleted the
 * track: its playlist entries, shrinking each playlist's counts, its likes, its plays, and its
 * queue entries, moving a queue that played one on to the entry after it. Each call clears what
 * its budget admits; a track whose rows are not all gone stays for the next call.
 */

/** Rows of one table one track's step deletes at most. */
const ROWS_PER_TABLE = 50;

/** A queue an entry is deleted from: its row, the entries around the one playing, and its write. */
const QUEUE_SETTLING = sumCost([
  atBound.read("playQueues"),
  atBound.read("playQueueEntries", 4),
  atBound.read("playQueueEntries", 4),
  atBound.patch("playQueues"),
]);

/** One track's step at worst, every table holding more rows than it deletes. */
const STEP_MOST = sumCost([
  atBound.read("playlistItems", ROWS_PER_TABLE),
  atBound.read("likes", ROWS_PER_TABLE),
  atBound.read("plays", ROWS_PER_TABLE),
  atBound.read("playQueueEntries", ROWS_PER_TABLE),
  ...Array.from({ length: ROWS_PER_TABLE }, () =>
    sumCost([
      atBound.delete("playlistItems"),
      atBound.read("playlists"),
      atBound.patch("playlists"),
      atBound.delete("likes"),
      atBound.delete("plays"),
      atBound.delete("playQueueEntries"),
      QUEUE_SETTLING,
    ]),
  ),
]);

/** Half a call: the purge's track deletes need the rest. */
const DEPENDENTS_LIMIT: Cost = {
  work: { ranges: CALL_COST.work.ranges / 2, writes: CALL_COST.work.writes / 2 },
  readBytes: CALL_COST.readBytes / 2,
  writeBytes: CALL_COST.writeBytes / 2,
  lyricBytes: CALL_COST.lyricBytes,
};

const shrink = async (store: MusicStore, item: Doc<"playlistItems">) => {
  await store.deletePlaylistItem(item._id);

  const playlist = await store.get("playlists", item.playlistId);

  if (playlist === null) return;

  await store.setPlaylist(playlist._id, {
    trackCount: Math.max(0, playlist.trackCount - 1),
    durationMs: Math.max(0, playlist.durationMs - item.durationMs),
  });
};

/** The entry next to `entry` in its queue's play order, after it first, else before it. */
const neighbour = async (
  store: MusicStore,
  entry: Doc<"playQueueEntries">,
): Promise<Doc<"playQueueEntries"> | null> => {
  const [after, before] = await Promise.all([
    store.take(
      "playQueueEntries",
      (q) =>
        q.withIndex("by_queue_order", (index) =>
          index
            .eq("userId", entry.userId)
            .eq("generation", entry.generation)
            .gte("order", entry.order),
        ),
      4,
    ),
    store.take(
      "playQueueEntries",
      (q) =>
        q
          .withIndex("by_queue_order", (index) =>
            index
              .eq("userId", entry.userId)
              .eq("generation", entry.generation)
              .lte("order", entry.order),
          )
          .order("desc"),
      4,
    ),
  ]);

  return (
    after.find((other) => other._id !== entry._id) ??
    before.find((other) => other._id !== entry._id) ??
    null
  );
};

const dropEntry = async (store: MusicStore, entry: Doc<"playQueueEntries">) => {
  const queue = await store.first("playQueues", (q) =>
    q.withIndex("by_user", (index) => index.eq("userId", entry.userId)),
  );

  if (queue !== null && queue.generation === entry.generation) {
    const current =
      queue.current === entry._id ? ((await neighbour(store, entry))?._id ?? null) : queue.current;

    await store.setQueue(queue._id, { current, count: Math.max(0, queue.count - 1) });
  }

  await store.deleteQueueEntry(entry._id);
};

/** Deletes up to `ROWS_PER_TABLE` rows of each kind for one track; answers whether all went. */
const clearOne = async (store: MusicStore, track: Doc<"tracks">): Promise<boolean> => {
  const [items, likes, plays, entries] = await Promise.all([
    store.take(
      "playlistItems",
      (q) => q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
      ROWS_PER_TABLE,
    ),
    store.take(
      "likes",
      (q) => q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
      ROWS_PER_TABLE,
    ),
    store.take(
      "plays",
      (q) => q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
      ROWS_PER_TABLE,
    ),
    store.take(
      "playQueueEntries",
      (q) => q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
      ROWS_PER_TABLE,
    ),
  ]);

  // One at a time: entries of one playlist or queue each read what the one before wrote.
  await inOrder(items, async (item) => shrink(store, item));
  await inOrder(entries, async (entry) => dropEntry(store, entry));

  await Promise.all([
    ...likes.map(async (like) => store.deleteLike(like._id)),
    ...plays.map(async (play) => store.deletePlay(play._id)),
  ]);

  return [items, likes, plays, entries].every((rows) => rows.length < ROWS_PER_TABLE);
};

/**
 * Clears what people keep of the leading `tracks` while half the call's budget admits another, and
 * answers the leading tracks whose rows are all gone, which the purge may then delete.
 */
export const clearDependents = async (
  store: MusicStore,
  tracks: ReadonlyArray<Doc<"tracks">>,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const cleared = await whileBudget(
    store.meter,
    DEPENDENTS_LIMIT,
    STEP_MOST,
    tracks,
    async (track) => clearOne(store, track),
  );

  const stop = cleared.indexOf(false);

  return tracks.slice(0, stop === -1 ? cleared.length : stop);
};
