import type { QueueEntry, QueueState, Track } from "@media/player/playback-controller";
import type { RepeatMode } from "@media/player/queue-order";

/** Songs a queue keeps at most, as the core's `music.queue.play` keeps 1,000. */
const MAX_QUEUE = 1000;

/** One play this phone made without the server, for `music.play.reportOffline`. */
interface OfflinePlay {
  readonly trackId: string;
  /** When it started, by this phone's clock. */
  readonly playedAt: number;
}

/**
 * This phone's own queue while the server cannot be reached, as old music's phone kept its own
 * session (`legacy/music/packages/player/src/local-session.ts`). It goes back to the server once
 * the server answers (D62).
 */
export interface LocalQueue<T extends Track> {
  /**
   * Every entry in play order: all of the server's, the songs this phone has no copy of included,
   * so the queue goes back whole, and those added here. The entry playing is always one this phone
   * holds, or null when it holds none.
   */
  readonly state: QueueState<T>;
  /** The entries whose song this phone holds a copy of: the ones it plays. */
  readonly held: ReadonlySet<string>;
  /** The entries in their order before shuffle, while shuffle is on and that order is known. */
  readonly unshuffled: ReadonlyArray<string> | null;
  /** The number in the next entry id made here. */
  readonly nextItem: number;
  /**
   * Entries were added, removed, moved, or replaced here since the queue left the server. Until
   * then the server's entries stand: only the entry playing, shuffle, repeat, and the plays go
   * back. Moving on to another entry, and turning shuffle or repeat, are not edits.
   */
  readonly changed: boolean;
  /** The server's shuffle and repeat when the queue left it; the hand-back sends any changed here. */
  readonly server: { readonly shuffle: boolean; readonly repeat: RepeatMode };
  /** Plays to hand to the server's history, in the order they started. */
  readonly plays: ReadonlyArray<OfflinePlay>;
}

const entryOf = <T extends Track>(track: T, itemId: string): QueueEntry<T> => ({
  itemId,
  autoplay: false,
  track,
});

const indexOf = <T extends Track>(
  entries: ReadonlyArray<QueueEntry<T>>,
  itemId: string | null,
): number => entries.findIndex((entry) => entry.itemId === itemId);

/**
 * The entry this phone plays from `from` on in `entries`: the first it holds at or after `from`,
 * else the last it holds before; null when it holds none.
 */
const heldFrom = <T extends Track>(
  entries: ReadonlyArray<QueueEntry<T>>,
  held: ReadonlySet<string>,
  from: number,
): string | null => {
  const start = Math.max(0, from);
  const after = entries.slice(start).find((entry) => held.has(entry.itemId));

  if (after !== undefined) return after.itemId;

  for (let index = Math.min(start, entries.length) - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry !== undefined && held.has(entry.itemId)) return entry.itemId;
  }

  return null;
};

/** `order` without the ids that are no longer entries of `entries`. */
const keptOrder = <T extends Track>(
  order: ReadonlyArray<string>,
  entries: ReadonlyArray<QueueEntry<T>>,
): ReadonlyArray<string> => {
  const present = new Set(entries.map((entry) => entry.itemId));

  return order.filter((id) => present.has(id));
};

/**
 * `entries` in their order before shuffle: those `unshuffled` lists in its order, then any it
 * doesn't list (none, normally) in the order they play, as old music's `shuffledOff`.
 */
const listedOrder = <T extends Track>(
  entries: ReadonlyArray<QueueEntry<T>>,
  unshuffled: ReadonlyArray<string> | null,
): ReadonlyArray<QueueEntry<T>> => {
  const byId = new Map(entries.map((entry) => [entry.itemId, entry]));
  const order = keptOrder(unshuffled ?? [], entries);
  const listed = new Set(order);

  return [
    ...order.flatMap((id) => {
      const entry = byId.get(id);

      return entry === undefined ? [] : [entry];
    }),
    ...entries.filter((entry) => !listed.has(entry.itemId)),
  ];
};

/** Fisher-Yates shuffle into a new array, drawing from `random` (uniform in `[0, 1)`). */
const shuffled = <A>(items: ReadonlyArray<A>, random: () => number): ReadonlyArray<A> => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = result[index];
    const swap = result[other];

    if (current !== undefined && swap !== undefined) {
      result[index] = swap;
      result[other] = current;
    }
  }

  return result;
};

/**
 * This phone's queue, starting from the server's last answer: every one of its entries, with this
 * phone's copy of each song it holds (`playable` answers it, or null), and the same shuffle and
 * repeat. It plays the server's entry when this phone holds it, else the next one it holds.
 *
 * @param moved - The entry the player moved to, when the server still holds it: it counts instead
 *   of the server's entry, as when a song ended and the core never confirmed the move to the next.
 */
export const seedLocal = <T extends Track>(
  server: QueueState<T> | null,
  playable: (trackId: string) => T | null,
  moved: string | null = null,
): LocalQueue<T> => {
  const held = new Set<string>();

  const entries = (server?.entries ?? []).map((entry) => {
    const copy = playable(entry.track.id);

    if (copy === null) return entry;
    held.add(entry.itemId);

    return { itemId: entry.itemId, autoplay: entry.autoplay, track: copy };
  });

  const shuffle = server?.shuffle ?? false;
  const repeat = server?.repeat ?? "off";
  const at = indexOf(entries, moved);

  return {
    state: {
      entries,
      current: heldFrom(
        entries,
        held,
        Math.max(0, at === -1 ? indexOf(entries, server?.current ?? null) : at),
      ),
      shuffle,
      repeat,
      autoplay: server?.autoplay ?? false,
    },
    held,
    unshuffled: null,
    nextItem: 1,
    changed: false,
    server: { shuffle, repeat },
    plays: [],
  };
};

/** What the player and the screens show: the entries this phone plays, the others left out. */
export const playingView = <T extends Track>(queue: LocalQueue<T>): QueueState<T> => ({
  ...queue.state,
  entries: queue.state.entries.filter((entry) => queue.held.has(entry.itemId)),
});

interface Made<T extends Track> {
  readonly entries: ReadonlyArray<QueueEntry<T>>;
  readonly ids: ReadonlyArray<string>;
  readonly nextItem: number;
}

/** New entries for `tracks`, songs this phone holds, with ids this queue has not used. */
const made = <T extends Track>(queue: LocalQueue<T>, tracks: ReadonlyArray<T>): Made<T> => {
  const entries = tracks.map((track, offset) =>
    entryOf(track, `local-${String(queue.nextItem + offset)}`),
  );

  return {
    entries,
    ids: entries.map((entry) => entry.itemId),
    nextItem: queue.nextItem + tracks.length,
  };
};

/** The queue with its entries edited here: the hand-back then sends them. */
const edited = <T extends Track>(
  queue: LocalQueue<T>,
  entries: ReadonlyArray<QueueEntry<T>>,
  current: string | null,
  unshuffled: ReadonlyArray<string> | null,
): LocalQueue<T> => ({
  ...queue,
  state: { ...queue.state, entries, current },
  unshuffled,
  changed: true,
});

/**
 * Replaces the queue with `tracks` (songs this phone holds) and plays the one at `index`, in the
 * order old music's `playOrder` and the core's `music.queue.play` give: with shuffle on, that song
 * first and the rest shuffled behind it, keeping their listed order to come back to.
 */
export const playLocal = <T extends Track>(
  queue: LocalQueue<T>,
  tracks: ReadonlyArray<T>,
  index: number,
  random: () => number,
): LocalQueue<T> => {
  const created = made(queue, tracks);
  const start = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, tracks.length - 1));
  const listed = created.entries;
  const chosen = listed[start];

  const played = queue.state.shuffle
    ? [
        ...(chosen === undefined ? [] : [chosen]),
        ...shuffled(
          listed.filter((_, position) => position !== start),
          random,
        ),
      ].slice(0, MAX_QUEUE)
    : listed.length > MAX_QUEUE
      ? listed.slice(start, start + MAX_QUEUE)
      : listed;

  return {
    ...edited(
      queue,
      played,
      chosen?.itemId ?? null,
      queue.state.shuffle ? keptOrder(created.ids, played) : null,
    ),
    held: new Set(created.ids),
    nextItem: created.nextItem,
  };
};

/** Plays the entry `itemId` when this phone holds it. Not an edit. */
export const jumpLocal = <T extends Track>(queue: LocalQueue<T>, itemId: string): LocalQueue<T> =>
  queue.held.has(itemId) && indexOf(queue.state.entries, itemId) !== -1
    ? { ...queue, state: { ...queue.state, current: itemId } }
    : queue;

/**
 * Where songs added "to the end" go, as old music's `endOfQueued`: after the songs people queued,
 * before the first upcoming entry autoplay added, so autoplay always plays last.
 */
const endOfQueued = <T extends Track>(
  entries: ReadonlyArray<QueueEntry<T>>,
  at: number,
): number => {
  const autoplayAt = entries.findIndex((entry, position) => position > at && entry.autoplay);

  return autoplayAt === -1 ? entries.length : autoplayAt;
};

/**
 * Adds `tracks` (songs this phone holds) right after the entry playing when `next` is set, else
 * after the songs people queued, keeping at most the queue's limit, as old music's `addedOrder`.
 * While shuffled, they join the order before shuffle at the same place.
 */
export const addLocal = <T extends Track>(
  queue: LocalQueue<T>,
  tracks: ReadonlyArray<T>,
  next: boolean,
): LocalQueue<T> => {
  const created = made(queue, tracks);
  const { entries, current } = queue.state;
  const at = indexOf(entries, current);
  const insertAt = next ? at + 1 : endOfQueued(entries, at);

  const kept = [
    ...entries.slice(0, insertAt),
    ...created.entries,
    ...entries.slice(insertAt),
  ].slice(0, MAX_QUEUE);

  const order = queue.unshuffled;
  const orderAt = order === null || !next ? 0 : order.indexOf(current ?? "") + 1;

  const unshuffled =
    order === null
      ? null
      : keptOrder(
          next
            ? [...order.slice(0, orderAt), ...created.ids, ...order.slice(orderAt)]
            : [...order, ...created.ids],
          kept,
        );

  return {
    ...edited(queue, kept, current ?? heldFrom(kept, new Set(created.ids), 0), unshuffled),
    held: new Set([...queue.held, ...created.ids]),
    nextItem: created.nextItem,
  };
};

/** Removes `itemId`; when it was the one playing, the next entry this phone holds plays. */
export const removeLocal = <T extends Track>(
  queue: LocalQueue<T>,
  itemId: string,
): LocalQueue<T> => {
  const at = indexOf(queue.state.entries, itemId);

  if (at === -1) return queue;
  const entries = queue.state.entries.filter((entry) => entry.itemId !== itemId);

  const current =
    queue.state.current === itemId ? heldFrom(entries, queue.held, at) : queue.state.current;

  return edited(
    queue,
    entries,
    current,
    queue.unshuffled === null ? null : keptOrder(queue.unshuffled, entries),
  );
};

/**
 * Moves `itemId` to just after `afterItemId`, or to the top without one. While shuffled, it moves
 * in the order before shuffle too, so the move holds once shuffle turns off.
 */
export const moveLocal = <T extends Track>(
  queue: LocalQueue<T>,
  itemId: string,
  afterItemId: string | undefined,
): LocalQueue<T> => {
  const moved = queue.state.entries.find((entry) => entry.itemId === itemId);

  if (moved === undefined || itemId === afterItemId) return queue;
  const rest = queue.state.entries.filter((entry) => entry.itemId !== itemId);
  const at = afterItemId === undefined ? 0 : indexOf(rest, afterItemId) + 1;

  if (afterItemId !== undefined && at === 0) return queue;

  const unshuffled = queue.unshuffled?.filter((id) => id !== itemId) ?? null;
  const after = afterItemId === undefined ? -1 : (unshuffled?.indexOf(afterItemId) ?? -1);

  return edited(
    queue,
    [...rest.slice(0, at), moved, ...rest.slice(at)],
    queue.state.current,
    unshuffled === null
      ? null
      : [...unshuffled.slice(0, after + 1), itemId, ...unshuffled.slice(after + 1)],
  );
};

/** Clears everything after the entry playing; with none playing, nothing. */
export const clearLocal = <T extends Track>(queue: LocalQueue<T>): LocalQueue<T> => {
  const at = indexOf(queue.state.entries, queue.state.current);

  if (at === -1) return queue;
  const entries = queue.state.entries.slice(0, at + 1);

  return edited(
    queue,
    entries,
    queue.state.current,
    queue.unshuffled === null ? null : keptOrder(queue.unshuffled, entries),
  );
};

/**
 * Turns shuffle on or off, as old music's `shuffledOn` and `shuffledOff` and the core's
 * `music.queue.shuffle`: on puts the entry playing first and the others after it in an order from
 * `random`, autoplay's last; off puts them back in the order before shuffle. Not an edit: the
 * hand-back turns shuffle on the server instead.
 */
export const shuffleLocal = <T extends Track>(
  queue: LocalQueue<T>,
  on: boolean,
  random: () => number,
): LocalQueue<T> => {
  if (on === queue.state.shuffle) return queue;
  const { entries, current } = queue.state;

  if (on) {
    const playing = entries.find((entry) => entry.itemId === current);
    const others = entries.filter((entry) => entry.itemId !== current);

    const order = [
      ...(playing === undefined ? [] : [playing]),
      ...shuffled(
        others.filter((entry) => !entry.autoplay),
        random,
      ),
      ...others.filter((entry) => entry.autoplay),
    ];

    return {
      ...queue,
      state: { ...queue.state, entries: order, shuffle: true },
      unshuffled: entries.map((entry) => entry.itemId),
    };
  }

  return {
    ...queue,
    state: { ...queue.state, entries: listedOrder(entries, queue.unshuffled), shuffle: false },
    unshuffled: null,
  };
};

/** Turns repeat. Not an edit: the hand-back turns it on the server instead. */
export const repeatLocal = <T extends Track>(
  queue: LocalQueue<T>,
  mode: RepeatMode,
): LocalQueue<T> => ({ ...queue, state: { ...queue.state, repeat: mode } });

export const recordPlay = <T extends Track>(
  queue: LocalQueue<T>,
  trackId: string,
  playedAt: number,
): LocalQueue<T> => ({ ...queue, plays: [...queue.plays, { trackId, playedAt }] });

/** One command of the hand-back. */
export type HandBackStep =
  /** `music.queue.play`: the queue edited here, in its order before shuffle. */
  | {
      readonly kind: "play";
      readonly trackIds: ReadonlyArray<string>;
      readonly index: number;
    }
  /** `music.queue.jump`: the server's entry this phone was playing. */
  | { readonly kind: "jump"; readonly itemId: string }
  | { readonly kind: "shuffle"; readonly on: boolean }
  | { readonly kind: "repeat"; readonly mode: RepeatMode };

/**
 * The commands that hand this phone's queue back to the server, in the order they run. The queue
 * goes back as a new one if an edit ran here, and otherwise only the entry playing does; shuffle
 * and repeat go back when they changed here. Shuffle turns before a new queue, so the server plays
 * it in that order, and after a jump, so the server shuffles around the entry playing.
 *
 * @param replaced - The server took another new queue after this phone went its own way (a play
 *   left unanswered that landed later), so it no longer holds the entries this phone names: the
 *   queue goes back whole.
 */
export const handBack = <T extends Track>(
  queue: LocalQueue<T>,
  replaced: boolean,
): ReadonlyArray<HandBackStep> => {
  const { entries, current, shuffle, repeat } = queue.state;
  const preferences: Array<HandBackStep> = [];

  if (shuffle !== queue.server.shuffle) preferences.push({ kind: "shuffle", on: shuffle });

  if (repeat !== queue.server.repeat) preferences.push({ kind: "repeat", mode: repeat });

  if ((queue.changed || replaced) && entries.length > 0) {
    const ordered = listedOrder(entries, queue.unshuffled);

    return [
      ...preferences,
      {
        kind: "play",
        trackIds: ordered.map((entry) => entry.track.id),
        index: Math.max(0, indexOf(ordered, current)),
      },
    ];
  }

  // Unedited, every entry is the server's own, so the server knows the one playing by its id.
  if (current === null || replaced) return preferences;

  return [{ kind: "jump", itemId: current }, ...preferences];
};
