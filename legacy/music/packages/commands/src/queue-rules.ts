/**
 * How a play queue moves and orders itself: where next and previous go, what counts as a new
 * play, where added songs land, and how shuffle reorders. Pure, so the server's playback commands
 * and a device's own session while it plays without the server follow the same rules.
 */
import type { RepeatMode } from "./models";

/** Longest queue kept; Convex arrays and query reads stay well inside limits. */
export const MAX_QUEUE = 1000;

const RESTART_THRESHOLD_MS = 3000;

/**
 * A report this close to the start of the song history last recorded, after the session had
 * played this much further, is the same song starting again (repeat one, or a seek back to the
 * start), so it counts as another play.
 */
const REPLAY_GAP_MS = 10_000;

/** How long after a command moves the queue a report naming another entry counts as stale. */
const MOVE_GRACE_MS = 3000;

/** One queue entry as the rules see it: its own ID, and whether autoplay added it. */
export interface QueueSlot {
  readonly id: string;
  readonly autoplay: boolean;
}

/** A queue's entries in play order, where it stands, and the order before shuffle. */
export interface QueueOrder<Item extends QueueSlot> {
  readonly items: ReadonlyArray<Item>;
  readonly index: number;
  /** The entry IDs in their order before shuffle, kept while shuffle is on. */
  readonly unshuffled: ReadonlyArray<Item["id"]> | undefined;
}

type CurrentOrder<Item extends QueueSlot> = Omit<QueueOrder<Item>, "unshuffled"> & {
  readonly unshuffled?: ReadonlyArray<Item["id"]> | undefined;
};

/** The entry `next` moves to, or null when the queue has run out. */
export const nextIndex = (index: number, length: number, repeat: RepeatMode): number | null => {
  if (index < length - 1) return index + 1;

  return repeat === "all" && length > 0 ? 0 : null;
};

/**
 * The entry `previous` moves to, given where the song is: the same one, from its start, once it
 * has played past the restart threshold; otherwise the one before, wrapping when repeat is all.
 */
export const previousIndex = (
  positionMs: number,
  index: number,
  length: number,
  repeat: RepeatMode,
): number => {
  if (positionMs > RESTART_THRESHOLD_MS) return index;

  if (index > 0) return index - 1;

  return repeat === "all" ? Math.max(0, length - 1) : 0;
};

/**
 * Whether a position report starts a new play for history: another song than the last one
 * recorded, or the same one started again after the session had played well past its start.
 *
 * @param report - The song the device reports, where it is in it, and whether it plays.
 * @param last - The song history last recorded (null before any), and the session's live
 *   position when the report arrived.
 */
export const isNewPlay = (
  report: { readonly trackId: string; readonly positionMs: number; readonly playing: boolean },
  last: { readonly trackId: string | null; readonly livePositionMs: number },
  durationMs: number,
): boolean => {
  // A short song loops sooner than the gap, so its gap is half its length.
  const gap = Math.min(REPLAY_GAP_MS, durationMs / 2);

  const startedAgain =
    report.trackId === last.trackId &&
    report.positionMs < gap &&
    last.livePositionMs - report.positionMs > gap;

  return report.playing && (report.trackId !== last.trackId || startedAgain);
};

/**
 * Whether a position report naming the entry at `reported` was sent before the player saw a skip
 * or jump that moved the session to `index` at `movedAt`. It is ignored: it would move the queue
 * back, and the player reports again once it plays the new entry.
 */
export const isStaleReport = (
  reported: number,
  index: number,
  movedAt: number | null,
  now: number,
): boolean => reported !== index && movedAt !== null && now - movedAt < MOVE_GRACE_MS;

/**
 * Where songs added "to the end" go: after the entries people queued, before the first upcoming
 * entry autoplay added, so autoplay always plays last.
 */
export const endOfQueued = (items: ReadonlyArray<QueueSlot>, index: number): number => {
  const autoplayAt = items.findIndex((item, position) => position > index && item.autoplay);

  return autoplayAt === -1 ? items.length : autoplayAt;
};

/** `order` without the IDs that are no longer entries of `items`. */
export const keptOrder = <Id extends string>(
  order: ReadonlyArray<Id>,
  items: ReadonlyArray<QueueSlot>,
): Array<Id> => {
  const present = new Set(items.map((item) => item.id));

  return order.filter((id) => present.has(id));
};

/**
 * The unshuffled order with `itemId` moved after `afterItemId` there too (or to the top), so a
 * move made while shuffled still holds once shuffle turns off.
 */
export const movedInOrder = <Id extends string>(
  order: ReadonlyArray<Id>,
  itemId: Id,
  afterItemId: Id | undefined,
): Array<Id> => {
  const rest = order.filter((id) => id !== itemId);
  const after = afterItemId === undefined ? -1 : rest.indexOf(afterItemId);

  return [...rest.slice(0, after + 1), itemId, ...rest.slice(after + 1)];
};

/** Fisher-Yates shuffle into a new array, drawing from `random` (uniform in `[0, 1)`). */
export const shuffled = <Item>(items: ReadonlyArray<Item>, random: () => number): Array<Item> => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = result[index];
    const swap = result[other];

    if (current === undefined || swap === undefined) continue;
    result[index] = swap;
    result[other] = current;
  }

  return result;
};

/**
 * The queue a new list starts as, playing `items[index]`. Shuffled, the whole list is shuffled
 * behind the chosen song and then cut to `MAX_QUEUE`, so a long list shuffled from a song near its
 * end still fills the queue; otherwise the queue is up to `MAX_QUEUE` songs from the chosen one
 * when the list is longer than that.
 */
export const playOrder = <Item extends QueueSlot>(
  items: ReadonlyArray<Item>,
  index: number,
  shuffle: boolean,
  random: () => number,
): QueueOrder<Item> => {
  if (shuffle) {
    const current = items[index];
    const others = items.filter((_, position) => position !== index);
    const rest = shuffled(others, random);
    const kept = (current === undefined ? rest : [current, ...rest]).slice(0, MAX_QUEUE);
    const listed = items.map((item) => item.id);

    return { items: kept, index: 0, unshuffled: keptOrder(listed, kept) };
  }

  if (items.length > MAX_QUEUE) {
    return { items: items.slice(index, index + MAX_QUEUE), index: 0, unshuffled: undefined };
  }

  return { items, index, unshuffled: undefined };
};

/**
 * The queue with shuffle turned on: the current entry first, then people's songs shuffled, then
 * autoplay's, so autoplay still plays last. The order before is kept to restore later.
 */
export const shuffledOn = <Item extends QueueSlot>(
  queue: CurrentOrder<Item>,
  random: () => number,
): QueueOrder<Item> => {
  const current = queue.items[queue.index];
  const others = queue.items.filter((_, position) => position !== queue.index);

  const rest = [
    ...shuffled(
      others.filter((item) => !item.autoplay),
      random,
    ),
    ...others.filter((item) => item.autoplay),
  ];

  return {
    items: current === undefined ? rest : [current, ...rest],
    index: 0,
    unshuffled: queue.items.map((item) => item.id),
  };
};

/**
 * The queue with shuffle turned off: back in the order before shuffle, still on the same entry.
 * Entries that order does not list (none, normally) go at the end.
 */
export const shuffledOff = <Item extends QueueSlot>(
  queue: CurrentOrder<Item>,
): QueueOrder<Item> => {
  const current = queue.items[queue.index];
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  const order = keptOrder(queue.unshuffled ?? [], queue.items);
  const listed = new Set<string>(order);

  const items = [
    ...order.flatMap((id) => {
      const item = byId.get(id);

      return item === undefined ? [] : [item];
    }),
    ...queue.items.filter((item) => !listed.has(item.id)),
  ];

  const index = current === undefined ? 0 : items.findIndex((item) => item.id === current.id);

  return { items, index: Math.max(0, index), unshuffled: undefined };
};

/** The queue without the upcoming entries autoplay added, for when autoplay turns off. */
export const withoutUpcomingAutoplay = <Item extends QueueSlot>(
  queue: CurrentOrder<Item>,
): QueueOrder<Item> => {
  const items = queue.items.filter((item, position) => position <= queue.index || !item.autoplay);

  return {
    items,
    index: queue.index,
    unshuffled: queue.unshuffled === undefined ? undefined : keptOrder(queue.unshuffled, items),
  };
};

/**
 * The queue with `added` placed right after the current entry (`next`) or after the songs people
 * queued (`end`), cut to `MAX_QUEUE`. While shuffled, the added entries join the order before
 * shuffle at the same place, so turning shuffle off keeps them. For a queue that has entries; an
 * empty queue simply becomes `added`.
 */
export const addedOrder = <Item extends QueueSlot>(
  queue: CurrentOrder<Item>,
  added: ReadonlyArray<Item>,
  placement: "next" | "end",
): QueueOrder<Item> => {
  const insertAt = placement === "next" ? queue.index + 1 : endOfQueued(queue.items, queue.index);

  const items = [...queue.items.slice(0, insertAt), ...added, ...queue.items.slice(insertAt)].slice(
    0,
    MAX_QUEUE,
  );

  const current = queue.items[queue.index];
  const addedIds = added.map((item) => item.id);

  const unshuffledAt = (order: ReadonlyArray<Item["id"]>): number =>
    placement === "next" && current !== undefined ? order.indexOf(current.id) + 1 : order.length;

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

  return { items, index: queue.index, unshuffled };
};
