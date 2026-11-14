import { v } from "convex/values";

import { register } from "../../commands/music/queue";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import type { Principal } from "../core/permissions/policy";
import { trackPlayer } from "./access";
import { AUTOPLAY_BATCH, autoplaySongs, shuffled } from "./autoplay";
import { NO_COST, addCost, cost, meterFrom } from "./budget";
import type { Cost } from "./budget";
import { DOCUMENT_BYTES, TABLE_BYTES } from "./fit";
import { orderBetween, ordersBetween, renumbered } from "./order";
import {
  personMeter,
  playDecider,
  readDecided,
  readDecidedLeading,
  requireTrackIds,
} from "./person";
import type { Decider } from "./person";
import { likedAmong, musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";
import { musicStore } from "./write";
import type { MusicStore } from "./write";

/** The longest queue kept, as old music's `MAX_QUEUE`. */
export const MAX_QUEUE = 1000;

/** Entries one scheduled page of a replaced queue's cleanup deletes. */
const PURGE_PAGE = 500;

const GONE = "That song is no longer in the queue";

type Queue = Doc<"playQueues">;

type Entry = Doc<"playQueueEntries">;

/** A queue before its first write: empty, with autoplay on, as old music's queues started. */
const EMPTY = {
  generation: 0,
  current: null,
  count: 0,
  shuffle: false,
  repeat: "off" as const,
  autoplay: true,
};

/**
 * Queue rows of one person a write reads: the one there should be, and a second a defect left,
 * which the write deletes, so the person has one queue again.
 */
const QUEUE_ROWS_READ = 2;

/** Rows a neighbour lookup reads: the anchor's peers at the same key, and the first after. */
const NEIGHBOURS = 4;

/** What writing every entry of a full queue costs: reading them all, then a patch each. */
const ALL_ENTRIES_COST = cost(
  1 + MAX_QUEUE,
  MAX_QUEUE,
  2 * MAX_QUEUE * DOCUMENT_BYTES.small,
  MAX_QUEUE * DOCUMENT_BYTES.small,
);

/** What one queue command keeps for its own reads and writes besides the songs it reads. */
const COMMAND_COST = cost(24, 4, 24 * DOCUMENT_BYTES.small, 4 * DOCUMENT_BYTES.small);

/** What topping a queue up with autoplay's songs writes, besides what autoplay reads. */
const TOP_UP_COST = cost(
  4,
  AUTOPLAY_BATCH + 1,
  4 * DOCUMENT_BYTES.small,
  (AUTOPLAY_BATCH + 1) * DOCUMENT_BYTES.small,
);

/** A person's queue, read once per command, with the store and deciders it writes through. */
interface Session {
  readonly db: DatabaseReader;
  readonly ctx: Pick<MutationCtx, "db" | "scheduler">;
  readonly store: MusicStore;
  readonly reach: Reach;
  readonly userId: Id<"users">;
  readonly decider: Decider;
}

const open = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  caller: Principal,
): Promise<{ readonly session: Session; readonly queue: Queue }> => {
  const reach = await reachOf(ctx.db, caller);
  const store = musicStore(ctx.db, personMeter(reach));

  const session: Session = {
    db: ctx.db,
    ctx,
    store,
    reach,
    userId: caller.userId,
    decider: playDecider(ctx.db, reach, store.meter),
  };

  const rows = await store.take(
    "playQueues",
    (q) => q.withIndex("by_user", (index) => index.eq("userId", caller.userId)),
    QUEUE_ROWS_READ,
  );

  const [row, ...extra] = rows;

  await Promise.all(extra.map(async (one) => store.deleteQueue(one._id)));

  if (row !== undefined) return { session, queue: row };

  const id = await store.insertQueue({ userId: caller.userId, ...EMPTY });

  return {
    session,
    queue: { _id: id, _creationTime: Date.now(), userId: caller.userId, ...EMPTY },
  };
};

/** Writes `fields` to the queue and answers it as written. */
const saved = async (
  session: Session,
  queue: Queue,
  fields: Partial<Omit<Queue, "_id" | "_creationTime" | "userId">>,
): Promise<Queue> => {
  await session.store.setQueue(queue._id, fields);

  return { ...queue, ...fields };
};

/** Whether `one` plays before `other`. */
const playsBefore = (one: Entry, other: Entry): boolean =>
  one.order < other.order || (one.order === other.order && one.tie < other.tie);

/** Whether `one` comes before `other` in the order before shuffle. */
const listedBefore = (one: Entry, other: Entry): boolean =>
  one.listOrder < other.listOrder || (one.listOrder === other.listOrder && one.tie < other.tie);

/** The queue's entry `itemId`, or `not_found` when it is not in the queue now. */
const entryOf = async (
  session: Session,
  queue: Queue,
  itemId: Id<"playQueueEntries">,
): Promise<Entry> => {
  const entry = await session.store.get("playQueueEntries", itemId);

  return entry === null || entry.userId !== session.userId || entry.generation !== queue.generation
    ? fail("not_found", GONE)
    : entry;
};

/** The entry that plays after `anchor`, skipping `skip`, or null at the end. */
const playsAfter = async (
  session: Session,
  queue: Queue,
  anchor: Entry,
  skip: Id<"playQueueEntries"> | null = null,
): Promise<Entry | null> => {
  const found = await session.store.take(
    "playQueueEntries",
    (q) =>
      q.withIndex("by_queue_order", (index) =>
        index
          .eq("userId", session.userId)
          .eq("generation", queue.generation)
          .gte("order", anchor.order),
      ),
    NEIGHBOURS,
  );

  return (
    found.find(
      (entry) => entry._id !== skip && entry._id !== anchor._id && playsBefore(anchor, entry),
    ) ?? null
  );
};

/** The entry that plays before `anchor`, or null at the top. */
const playsBeforeOf = async (
  session: Session,
  queue: Queue,
  anchor: Entry,
): Promise<Entry | null> => {
  const found = await session.store.take(
    "playQueueEntries",
    (q) =>
      q
        .withIndex("by_queue_order", (index) =>
          index
            .eq("userId", session.userId)
            .eq("generation", queue.generation)
            .lte("order", anchor.order),
        )
        .order("desc"),
    NEIGHBOURS,
  );

  return found.find((entry) => entry._id !== anchor._id && playsBefore(entry, anchor)) ?? null;
};

/** The entry after `anchor` in the order before shuffle, skipping `skip`, or null at the end. */
const listedAfter = async (
  session: Session,
  queue: Queue,
  anchor: Entry,
  skip: Id<"playQueueEntries"> | null = null,
): Promise<Entry | null> => {
  const found = await session.store.take(
    "playQueueEntries",
    (q) =>
      q.withIndex("by_queue_list", (index) =>
        index
          .eq("userId", session.userId)
          .eq("generation", queue.generation)
          .gte("listOrder", anchor.listOrder),
      ),
    NEIGHBOURS,
  );

  return (
    found.find(
      (entry) => entry._id !== skip && entry._id !== anchor._id && listedBefore(anchor, entry),
    ) ?? null
  );
};

/** The first entry of the queue in play or list order, skipping `skip`. */
const firstOf = async (
  session: Session,
  queue: Queue,
  index: "by_queue_order" | "by_queue_list",
  skip: Id<"playQueueEntries"> | null = null,
  last = false,
): Promise<Entry | null> => {
  const found = await session.store.take(
    "playQueueEntries",
    (q) =>
      q
        .withIndex(index, (range) =>
          range.eq("userId", session.userId).eq("generation", queue.generation),
        )
        .order(last ? "desc" : "asc"),
    2,
  );

  return found.find((entry) => entry._id !== skip) ?? null;
};

/** Every entry of the queue in play order: at most `MAX_QUEUE`. */
const allEntries = (session: Session, queue: Queue): Promise<ReadonlyArray<Entry>> =>
  session.store.take(
    "playQueueEntries",
    (q) =>
      q.withIndex("by_queue_order", (index) =>
        index.eq("userId", session.userId).eq("generation", queue.generation),
      ),
    MAX_QUEUE,
  );

/**
 * Rewrites every entry's play and list keys from the top, keeping both orders, for an insert or a
 * move whose neighbours sit too close to split. A queue holds at most 1,000 entries, a patch each.
 */
const renumber = async (session: Session, queue: Queue): Promise<void> => {
  const entries = await allEntries(session, queue);
  const listed = entries.toSorted((one, other) => (listedBefore(one, other) ? -1 : 1));
  const listIndex = new Map(listed.map((entry, index) => [entry._id, index]));

  await Promise.all(
    entries.map(async (entry, index) => {
      const order = renumbered(index);
      const listOrder = renumbered(listIndex.get(entry._id) ?? index);

      if (entry.order !== order || entry.listOrder !== listOrder) {
        await session.store.setQueueEntryOrder(entry._id, { order, listOrder });
      }
    }),
  );
};

/** Where new entries go in one order: between two keys, either missing at an end. */
interface Slot {
  readonly before: number | null;
  readonly after: number | null;
}

/** Where new entries go in both orders, read again each time it runs. */
type Place = () => Promise<{ readonly play: Slot; readonly list: Slot }>;

const slotAfter = (
  anchor: number | null,
  next: Entry | null,
  key: (entry: Entry) => number,
): Slot => ({
  before: anchor,
  after: next === null ? null : key(next),
});

/**
 * Inserts entries for `tracks` at `play` in play order and at `list` in the order before shuffle,
 * renumbering first when a slot is too narrow, and answers their ids in order. `place` reads the
 * entries around the slots each time it runs, so after a renumber it finds them at their new keys.
 */
const insertAt = async (
  session: Session,
  queue: Queue,
  trackIds: ReadonlyArray<Id<"tracks">>,
  autoplay: boolean,
  place: Place,
  renumberedOnce = false,
): Promise<ReadonlyArray<Id<"playQueueEntries">>> => {
  const slots = await place();
  const plays = ordersBetween(slots.play.before, slots.play.after, trackIds.length);
  const lists = ordersBetween(slots.list.before, slots.list.after, trackIds.length);

  if (plays === null || lists === null) {
    // Renumbering leaves a whole step between neighbours, so a slot `place` reads again after it
    // always fits; one still too narrow is a defect in `place`.
    if (renumberedOnce) throw new Error("A queue slot stayed too narrow after renumbering");

    await renumber(session, queue);

    return insertAt(session, queue, trackIds, autoplay, place, true);
  }

  return Promise.all(
    trackIds.map(async (trackId, index) =>
      session.store.insertQueueEntry({
        userId: session.userId,
        generation: queue.generation,
        order: plays[index] ?? 0,
        listOrder: lists[index] ?? 0,
        trackId,
        autoplay,
      }),
    ),
  );
};

/**
 * Tops the queue up as old music's `toppedUp` did: when autoplay is on, repeat is off, and the
 * current entry is the last, autoplay's songs join after it. It runs only while the call can still
 * pay for autoplay's reads.
 */
const toppedUp = async (session: Session, queue: Queue): Promise<Queue> => {
  if (!queue.autoplay || queue.repeat !== "off" || queue.current === null) return queue;

  const room = MAX_QUEUE - queue.count;
  const current = await session.store.get("playQueueEntries", queue.current);

  if (room <= 0 || current === null || (await playsAfter(session, queue, current)) !== null) {
    return queue;
  }

  const seed = await session.store.get("tracks", current.trackId);

  if (seed === null) return queue;

  const queued = (await allEntries(session, queue)).map((entry) => entry.trackId);

  const songs = (
    await autoplaySongs(
      session.db,
      session.store,
      session.reach,
      session.decider,
      seed,
      queued,
      TOP_UP_COST,
    )
  ).slice(0, room);

  if (songs.length === 0) return queue;

  await insertAt(session, queue, songs, true, async () => {
    const fresh = await entryOf(session, queue, current._id);
    const last = await firstOf(session, queue, "by_queue_list", null, true);

    return {
      play: { before: fresh.order, after: null },
      list: { before: last?.listOrder ?? fresh.listOrder, after: null },
    };
  });

  return saved(session, queue, { count: queue.count + songs.length });
};

/**
 * Reads and decides `trackIds` for play, as old music's `playableTracks` did: each must exist and
 * be one the caller may play, or the call fails `not_found`; songs whose files went missing are
 * left out, and the call fails when none is left. Answers the songs kept, and where `index` lands
 * among them.
 */
const playableTracks = async (
  session: Session,
  trackIds: ReadonlyArray<Id<"tracks">>,
  index: number,
  reserve: Cost,
): Promise<{ readonly tracks: ReadonlyArray<Doc<"tracks">>; readonly index: number }> => {
  const decided = await readDecided(session.store, session.decider, trackIds, reserve);
  const refused = decided.find(({ track, allowed }) => track === null || !allowed);

  if (refused !== undefined) return fail("not_found", `Track ${refused.id} not found`);

  const tracks = decided.flatMap(({ track }) => (track === null || track.missing ? [] : [track]));

  if (tracks.length === 0) {
    return fail("not_found", "None of those songs can play: their files are missing");
  }

  const kept = decided
    .slice(0, index)
    .filter(({ track }) => track !== null && !track.missing).length;

  return { tracks, index: Math.min(kept, tracks.length - 1) };
};

/** What writing `count` new entries costs. */
const entriesCost = (count: number): Cost => cost(0, count, 0, count * DOCUMENT_BYTES.small);

/**
 * The order a new queue plays `tracks` in, as old music's `playOrder`: shuffled, the chosen song
 * first and the rest shuffled behind it, cut to `MAX_QUEUE`, keeping their listed order to come
 * back to; otherwise up to `MAX_QUEUE` songs from the chosen one when the list is longer.
 */
const playOrder = (tracks: ReadonlyArray<Doc<"tracks">>, index: number, shuffle: boolean) => {
  const listed = tracks.map((track, position) => ({ track, listed: position }));

  if (shuffle) {
    const chosen = listed[index];
    const rest = shuffled(listed.filter((_, position) => position !== index));

    return {
      played: (chosen === undefined ? rest : [chosen, ...rest]).slice(0, MAX_QUEUE),
      start: 0,
    };
  }

  return listed.length > MAX_QUEUE
    ? { played: listed.slice(index, index + MAX_QUEUE), start: 0 }
    : { played: listed, start: index };
};

/** Schedules deleting the entries of every generation before `generation`, a page at a time. */
const purgeBefore = async (session: Session, generation: number): Promise<void> => {
  await session.ctx.scheduler.runAfter(0, internal.music.queue.purgeEntries, {
    userId: session.userId,
    below: generation,
  });
};

/** Deletes the entries after the current one in play order, as `withoutUpcoming` chooses. */
const deleteUpcoming = async (
  session: Session,
  queue: Queue,
  which: (entry: Entry) => boolean,
): Promise<number> => {
  const current =
    queue.current === null ? null : await session.store.get("playQueueEntries", queue.current);

  const entries = await allEntries(session, queue);

  const leaving = entries.filter(
    (entry) =>
      (current === null || playsBefore(current, entry)) &&
      entry._id !== current?._id &&
      which(entry),
  );

  await Promise.all(leaving.map(async (entry) => session.store.deleteQueueEntry(entry._id)));

  return leaving.length;
};

/**
 * Where `music.queue.add` puts songs: right after `after` in both orders when it names an entry
 * (the current one for `--next`, or the last one a call before added); at the end of an empty
 * queue; otherwise after the songs people queued and before autoplay's, and at the end of the
 * order before shuffle, as old music's `addedOrder` placed them.
 */
const addedSlots =
  (session: Session, queue: Queue, current: Entry | null, after: Entry | null): Place =>
  async () => {
    if (after !== null) {
      const fresh = await entryOf(session, queue, after._id);
      const next = await playsAfter(session, queue, fresh);
      const play = slotAfter(fresh.order, next, (entry) => entry.order);

      if (!queue.shuffle) return { play, list: play };

      const listNext = await listedAfter(session, queue, fresh);

      return { play, list: slotAfter(fresh.listOrder, listNext, (entry) => entry.listOrder) };
    }

    const lastListed = await firstOf(session, queue, "by_queue_list", null, true);

    if (current === null) {
      const last = await firstOf(session, queue, "by_queue_order", null, true);

      return {
        play: { before: last?.order ?? null, after: null },
        list: { before: lastListed?.listOrder ?? null, after: null },
      };
    }

    const fresh = await entryOf(session, queue, current._id);

    const autoplayed = await session.store.first("playQueueEntries", (q) =>
      q.withIndex("by_queue_autoplay", (index) =>
        index
          .eq("userId", session.userId)
          .eq("generation", queue.generation)
          .eq("autoplay", true)
          .gt("order", fresh.order),
      ),
    );

    const before =
      autoplayed === null
        ? await firstOf(session, queue, "by_queue_order", null, true)
        : await playsBeforeOf(session, queue, autoplayed);

    const play = { before: before?.order ?? fresh.order, after: autoplayed?.order ?? null };

    return {
      play,
      list: queue.shuffle ? { before: lastListed?.listOrder ?? null, after: null } : play,
    };
  };

/**
 * Renumbers the queue now when `place`'s slots are too narrow for `count` entries, before a call
 * reads its songs: the renumber writes at most `MAX_QUEUE` entries, and the songs then take what
 * the call has left, so adding never renumbers after it has read them (ADR 0024).
 */
const widen = async (
  session: Session,
  queue: Queue,
  count: number,
  place: Place,
): Promise<void> => {
  const slots = await place();

  if (
    ordersBetween(slots.play.before, slots.play.after, count) === null ||
    ordersBetween(slots.list.before, slots.list.after, count) === null
  ) {
    await renumber(session, queue);
  }
};

export const { get, list, play, add, remove, move, clear, jump, shuffle, repeat, autoplay } =
  register({
    get: async (ctx, _args, caller) => {
      const row = await ctx.db
        .query("playQueues")
        .withIndex("by_user", (q) => q.eq("userId", caller.userId))
        .first();

      const queue = row ?? EMPTY;

      return {
        current: queue.current,
        count: queue.count,
        shuffle: queue.shuffle,
        repeat: queue.repeat,
        autoplay: queue.autoplay,
      };
    },
    list: async (ctx, { paginationOpts }, caller) => {
      const reach = await reachOf(ctx.db, caller);

      const row = await ctx.db
        .query("playQueues")
        .withIndex("by_user", (q) => q.eq("userId", caller.userId))
        .first();

      const generation = row?.generation ?? EMPTY.generation;

      const page = await paginateAtMost(
        ctx.db,
        {
          table: "playQueueEntries",
          index: "by_queue_order",
          range: (q) => q.eq("userId", caller.userId).eq("generation", generation),
        },
        paginationOpts,
        pageRowsFor(reach, reach.lent === null ? 4 : 10, TRACK_ROW_BYTES + 2 * TABLE_BYTES.tracks),
      );

      const plays = trackPlayer(ctx.db, reach);

      const found = await Promise.all(
        page.page.map(async (entry) => {
          const track = await ctx.db.get(entry.trackId);

          return track !== null && (await plays(track)) ? [{ entry, track }] : [];
        }),
      );

      const entries = found.flat();

      const liked = await likedAmong(
        ctx.db,
        caller.userId,
        entries.map(({ track }) => track._id),
      );

      const present = musicPresenter();

      return {
        ...page,
        page: await Promise.all(
          entries.map(async ({ entry, track }) => ({
            itemId: entry._id,
            autoplay: entry.autoplay,
            track: await present.track(track, liked.has(track._id)),
          })),
        ),
      };
    },
    play: async (ctx, args, caller) => {
      requireTrackIds(args.trackIds);

      const index = args.index ?? 0;

      if (!Number.isInteger(index) || index < 0 || index >= args.trackIds.length) {
        return fail("invalid_args", "--index names a position in the songs, from 0");
      }

      const { session, queue } = await open(ctx, caller);

      const reserve = cost(
        COMMAND_COST.work.ranges,
        MAX_QUEUE,
        COMMAND_COST.readBytes,
        MAX_QUEUE * DOCUMENT_BYTES.small,
      );

      const playable = await playableTracks(session, args.trackIds, index, reserve);
      const { played, start } = playOrder(playable.tracks, playable.index, queue.shuffle);
      const generation = queue.generation + 1;

      session.store.meter.charge(entriesCost(played.length));

      const ids = await Promise.all(
        played.map(async ({ track, listed }, position) =>
          session.store.insertQueueEntry({
            userId: session.userId,
            generation,
            order: renumbered(position),
            listOrder: renumbered(queue.shuffle ? listed : position),
            trackId: track._id,
            autoplay: false,
          }),
        ),
      );

      const current = ids[start] ?? fail("not_found", "None of those songs can play");
      const next = await saved(session, queue, { generation, current, count: ids.length });

      if (queue.count > 0 || queue.generation > 0) await purgeBefore(session, generation);

      await toppedUp(session, next);

      return { current };
    },
    add: async (ctx, { trackIds, next: playNext, afterItemId }, caller) => {
      requireTrackIds(trackIds);

      const { session, queue } = await open(ctx, caller);

      // Songs past the queue's room never join it, as old music cut them at `MAX_QUEUE`.
      const room = Math.max(0, MAX_QUEUE - queue.count);

      if (room === 0) return { itemIds: [], rest: [] };

      const anchor = afterItemId === undefined ? null : await entryOf(session, queue, afterItemId);

      const current =
        queue.current === null ? null : await session.store.get("playQueueEntries", queue.current);

      const place = addedSlots(
        session,
        queue,
        current,
        anchor ?? (playNext === true ? current : null),
      );

      const most = Math.min(trackIds.length, room);

      await widen(session, queue, most, place);

      // It reads until the queue is full, so a song whose file went missing takes no room.
      const decided = await readDecidedLeading(
        session.store,
        session.decider,
        trackIds,
        addCost(COMMAND_COST, entriesCost(most)),
        { most: room, counts: ({ track }) => track !== null && !track.missing },
      );

      const refused = decided.find(({ track, allowed }) => track === null || !allowed);

      if (refused !== undefined) return fail("not_found", `Track ${refused.id} not found`);

      const songs = decided.flatMap(({ track }) =>
        track === null || track.missing ? [] : [track._id],
      );

      const rest = songs.length >= room ? [] : trackIds.slice(decided.length);

      if (songs.length === 0) {
        return rest.length === 0 && anchor === null
          ? fail("not_found", "None of those songs can play: their files are missing")
          : { itemIds: [], rest };
      }

      const itemIds = await insertAt(session, queue, songs, false, place);
      const count = queue.count + itemIds.length;

      if (current === null) {
        const started = await saved(session, queue, { current: itemIds[0] ?? null, count });

        // Autoplay waits for the songs the caller sends again, which go before its own.
        if (rest.length === 0) await toppedUp(session, started);
      } else {
        await saved(session, queue, { count });
      }

      return { itemIds: [...itemIds], rest };
    },
    remove: async (ctx, { itemId }, caller) => {
      const { session, queue } = await open(ctx, caller);
      const entry = await entryOf(session, queue, itemId);

      const current =
        queue.current === entry._id
          ? ((
              (await playsAfter(session, queue, entry)) ??
              (await playsBeforeOf(session, queue, entry))
            )?._id ?? null)
          : queue.current;

      await session.store.deleteQueueEntry(entry._id);
      await toppedUp(
        session,
        await saved(session, queue, { current, count: Math.max(0, queue.count - 1) }),
      );

      return null;
    },
    move: async (ctx, { itemId, afterItemId }, caller) => {
      if (afterItemId === itemId) return fail("invalid_args", "An entry can't move after itself");

      const { session, queue } = await open(ctx, caller);
      const moving = await entryOf(session, queue, itemId);
      const after = afterItemId === undefined ? null : await entryOf(session, queue, afterItemId);

      const place: Place = async () => {
        const fresh = await entryOf(session, queue, moving._id);
        const anchor = after === null ? null : await entryOf(session, queue, after._id);

        const playNext =
          anchor === null
            ? await firstOf(session, queue, "by_queue_order", fresh._id)
            : await playsAfter(session, queue, anchor, fresh._id);

        const playSlot: Slot =
          anchor === null
            ? { before: null, after: playNext?.order ?? null }
            : slotAfter(anchor.order, playNext, (entry) => entry.order);

        if (!queue.shuffle) return { play: playSlot, list: playSlot };

        const listNext =
          anchor === null
            ? await firstOf(session, queue, "by_queue_list", fresh._id)
            : await listedAfter(session, queue, anchor, fresh._id);

        return {
          play: playSlot,
          list:
            anchor === null
              ? { before: null, after: listNext?.listOrder ?? null }
              : slotAfter(anchor.listOrder, listNext, (entry) => entry.listOrder),
        };
      };

      const slots = await place();
      const order = orderBetween(slots.play.before, slots.play.after);
      const listOrder = orderBetween(slots.list.before, slots.list.after);

      if (order === null || listOrder === null) {
        await renumber(session, queue);

        const again = await place();

        await session.store.setQueueEntryOrder(moving._id, {
          order: orderBetween(again.play.before, again.play.after) ?? 0,
          listOrder: orderBetween(again.list.before, again.list.after) ?? 0,
        });
      } else {
        await session.store.setQueueEntryOrder(moving._id, { order, listOrder });
      }

      await toppedUp(session, queue);

      return null;
    },
    clear: async (ctx, _args, caller) => {
      const { session, queue } = await open(ctx, caller);

      session.store.meter.charge(ALL_ENTRIES_COST);

      const deleted = queue.current === null ? 0 : await deleteUpcoming(session, queue, () => true);

      await toppedUp(
        session,
        await saved(session, queue, { count: Math.max(0, queue.count - deleted) }),
      );

      return null;
    },
    jump: async (ctx, { itemId }, caller) => {
      const { session, queue } = await open(ctx, caller);
      const entry = await entryOf(session, queue, itemId);

      await toppedUp(session, await saved(session, queue, { current: entry._id }));

      return null;
    },
    shuffle: async (ctx, { on }, caller) => {
      const { session, queue } = await open(ctx, caller);

      if (on === queue.shuffle) return null;

      const entries = await allEntries(session, queue);

      if (on) {
        const current = entries.find((entry) => entry._id === queue.current);
        const others = entries.filter((entry) => entry._id !== queue.current);

        const order = [
          ...(current === undefined ? [] : [current]),
          ...shuffled(others.filter((entry) => !entry.autoplay)),
          ...others.filter((entry) => entry.autoplay),
        ];

        await Promise.all(
          order.map(async (entry, index) =>
            session.store.setQueueEntryOrder(entry._id, {
              order: renumbered(index),
              listOrder: entry.order,
            }),
          ),
        );
      } else {
        const listed = entries.toSorted((one, other) => (listedBefore(one, other) ? -1 : 1));

        await Promise.all(
          listed.map(async (entry, index) =>
            session.store.setQueueEntryOrder(entry._id, {
              order: renumbered(index),
              listOrder: renumbered(index),
            }),
          ),
        );
      }

      await saved(session, queue, { shuffle: on });

      return null;
    },
    repeat: async (ctx, { mode }, caller) => {
      const { session, queue } = await open(ctx, caller);

      await saved(session, queue, { repeat: mode });

      return null;
    },
    autoplay: async (ctx, { on }, caller) => {
      const { session, queue } = await open(ctx, caller);

      if (on) {
        await toppedUp(session, await saved(session, queue, { autoplay: true }));

        return null;
      }

      session.store.meter.charge(ALL_ENTRIES_COST);

      const deleted = await deleteUpcoming(session, queue, (entry) => entry.autoplay);

      await saved(session, queue, { autoplay: false, count: Math.max(0, queue.count - deleted) });

      return null;
    },
  });

/**
 * Deletes one page of the entries a person's replaced queues left, every generation before
 * `below`, and schedules the next page. Reads never see them: they read the current generation.
 */
export const purgeEntries = internalMutation({
  args: { userId: v.id("users"), below: v.number() },
  returns: v.null(),
  handler: async (ctx, { userId, below }) => {
    const store = musicStore(ctx.db, meterFrom(NO_COST));

    const stale = await store.take(
      "playQueueEntries",
      (q) =>
        q.withIndex("by_queue_order", (index) =>
          index.eq("userId", userId).lt("generation", below),
        ),
      PURGE_PAGE,
    );

    await Promise.all(stale.map(async (entry) => store.deleteQueueEntry(entry._id)));

    if (stale.length === PURGE_PAGE) {
      await ctx.scheduler.runAfter(0, internal.music.queue.purgeEntries, { userId, below });
    }

    return null;
  },
});
