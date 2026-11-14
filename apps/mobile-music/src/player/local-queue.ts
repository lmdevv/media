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
 * This phone's own queue while the server cannot be reached: the downloaded songs it plays, in
 * order, with the same shuffle, repeat, and entry playing as the core's queue keeps. It goes back
 * to the server once the server answers (D62).
 */
export interface LocalQueue<T extends Track> {
  readonly state: QueueState<T>;
  /** The entries in their order before shuffle, while shuffle is on. */
  readonly unshuffled: ReadonlyArray<string> | null;
  /** The number in the next entry id made here. */
  readonly nextItem: number;
  /**
   * A command ran here since the queue left the server. Until one does, the server's queue
   * stands, and only the plays go back.
   */
  readonly changed: boolean;
  /** Plays to hand to the server's history, in the order they started. */
  readonly plays: ReadonlyArray<OfflinePlay>;
}

const entryOf = <T extends Track>(track: T, itemId: string): QueueEntry<T> => ({
  itemId,
  autoplay: false,
  track,
});

/**
 * This phone's queue, starting from the server's last answer: its entries this phone holds a copy
 * of, the same entry playing when it is one of them, and the same shuffle and repeat. `playable`
 * answers this phone's copy of a song, or null.
 */
export const seedLocal = <T extends Track>(
  server: QueueState<T> | null,
  playable: (trackId: string) => T | null,
): LocalQueue<T> => {
  const entries = (server?.entries ?? []).flatMap((entry) => {
    const track = playable(entry.track.id);

    return track === null ? [] : [{ ...entry, track }];
  });

  const current = entries.some((entry) => entry.itemId === server?.current)
    ? (server?.current ?? null)
    : (entries[0]?.itemId ?? null);

  return {
    state: {
      entries,
      current,
      shuffle: server?.shuffle ?? false,
      repeat: server?.repeat ?? "off",
      autoplay: server?.autoplay ?? false,
    },
    unshuffled: null,
    nextItem: 1,
    changed: false,
    plays: [],
  };
};

const indexOf = <T extends Track>(queue: LocalQueue<T>, itemId: string | null): number =>
  queue.state.entries.findIndex((entry) => entry.itemId === itemId);

const withEntries = <T extends Track>(
  queue: LocalQueue<T>,
  entries: ReadonlyArray<QueueEntry<T>>,
  current: string | null,
): LocalQueue<T> => ({
  ...queue,
  state: { ...queue.state, entries, current },
  changed: true,
});

interface Made<T extends Track> {
  readonly entries: ReadonlyArray<QueueEntry<T>>;
  readonly nextItem: number;
}

const made = <T extends Track>(queue: LocalQueue<T>, tracks: ReadonlyArray<T>): Made<T> => ({
  entries: tracks.map((track, offset) =>
    entryOf(track, `local-${String(queue.nextItem + offset)}`),
  ),
  nextItem: queue.nextItem + tracks.length,
});

export const playLocal = <T extends Track>(
  queue: LocalQueue<T>,
  tracks: ReadonlyArray<T>,
  index = 0,
): LocalQueue<T> => {
  const { entries, nextItem } = made(queue, tracks.slice(0, MAX_QUEUE));
  const start = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, entries.length - 1));

  return {
    ...withEntries(queue, entries, entries[start]?.itemId ?? null),
    unshuffled: queue.state.shuffle ? entries.map((entry) => entry.itemId) : null,
    nextItem,
  };
};

export const jumpLocal = <T extends Track>(queue: LocalQueue<T>, itemId: string): LocalQueue<T> =>
  indexOf(queue, itemId) === -1 ? queue : withEntries(queue, queue.state.entries, itemId);

/**
 * Adds `tracks` right after the entry playing when `next` is set, else at the end, keeping at most
 * the queue's limit.
 */
export const addLocal = <T extends Track>(
  queue: LocalQueue<T>,
  tracks: ReadonlyArray<T>,
  next: boolean,
): LocalQueue<T> => {
  const room = Math.max(0, MAX_QUEUE - queue.state.entries.length);
  const { entries: added, nextItem } = made(queue, tracks.slice(0, room));
  const at = next ? indexOf(queue, queue.state.current) + 1 : queue.state.entries.length;
  const entries = [...queue.state.entries.slice(0, at), ...added, ...queue.state.entries.slice(at)];
  const current = queue.state.current ?? entries[0]?.itemId ?? null;

  return {
    ...withEntries(queue, entries, current),
    nextItem,
    unshuffled:
      queue.unshuffled === null ? null : [...queue.unshuffled, ...added.map((e) => e.itemId)],
  };
};

/** Removes `itemId`; the entry after it plays when it was the one playing. */
export const removeLocal = <T extends Track>(
  queue: LocalQueue<T>,
  itemId: string,
): LocalQueue<T> => {
  const at = indexOf(queue, itemId);

  if (at === -1) return queue;
  const entries = queue.state.entries.filter((entry) => entry.itemId !== itemId);

  const current =
    queue.state.current === itemId
      ? (entries[Math.min(at, entries.length - 1)]?.itemId ?? null)
      : queue.state.current;

  return {
    ...withEntries(queue, entries, current),
    unshuffled: queue.unshuffled?.filter((id) => id !== itemId) ?? null,
  };
};

/** Moves `itemId` to just after `afterItemId`, or to the top without one. */
export const moveLocal = <T extends Track>(
  queue: LocalQueue<T>,
  itemId: string,
  afterItemId: string | undefined,
): LocalQueue<T> => {
  const moved = queue.state.entries.find((entry) => entry.itemId === itemId);

  if (moved === undefined || itemId === afterItemId) return queue;
  const rest = queue.state.entries.filter((entry) => entry.itemId !== itemId);
  const at = afterItemId === undefined ? 0 : rest.findIndex((e) => e.itemId === afterItemId) + 1;

  if (afterItemId !== undefined && at === 0) return queue;

  return withEntries(queue, [...rest.slice(0, at), moved, ...rest.slice(at)], queue.state.current);
};

/** Clears everything after the entry playing. */
export const clearLocal = <T extends Track>(queue: LocalQueue<T>): LocalQueue<T> => {
  const at = indexOf(queue, queue.state.current);
  const entries = queue.state.entries.slice(0, at + 1);
  const kept = new Set(entries.map((entry) => entry.itemId));

  return {
    ...withEntries(queue, entries, queue.state.current),
    unshuffled: queue.unshuffled?.filter((id) => kept.has(id)) ?? null,
  };
};

/**
 * Turns shuffle on, putting the entries after the one playing in an order from `random`, or off,
 * putting them back in the order they had.
 */
export const shuffleLocal = <T extends Track>(
  queue: LocalQueue<T>,
  on: boolean,
  random: () => number,
): LocalQueue<T> => {
  if (on === queue.state.shuffle) return queue;
  const at = indexOf(queue, queue.state.current);
  const head = queue.state.entries.slice(0, at + 1);
  const tail = queue.state.entries.slice(at + 1);

  if (on) {
    const shuffled = [...tail];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(random() * (index + 1));
      const swap = shuffled[index];
      const picked = shuffled[pick];

      if (swap !== undefined && picked !== undefined) {
        shuffled[index] = picked;
        shuffled[pick] = swap;
      }
    }

    return {
      ...withEntries(queue, [...head, ...shuffled], queue.state.current),
      unshuffled: queue.state.entries.map((entry) => entry.itemId),
      state: { ...queue.state, entries: [...head, ...shuffled], shuffle: true },
    };
  }

  const order = new Map((queue.unshuffled ?? []).map((id, index) => [id, index]));

  const restored = tail.toSorted(
    (a, b) =>
      (order.get(a.itemId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.itemId) ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    ...withEntries(queue, [...head, ...restored], queue.state.current),
    unshuffled: null,
    state: { ...queue.state, entries: [...head, ...restored], shuffle: false },
  };
};

export const repeatLocal = <T extends Track>(
  queue: LocalQueue<T>,
  mode: RepeatMode,
): LocalQueue<T> => ({ ...queue, state: { ...queue.state, repeat: mode }, changed: true });

export const recordPlay = <T extends Track>(
  queue: LocalQueue<T>,
  trackId: string,
  playedAt: number,
): LocalQueue<T> => ({ ...queue, plays: [...queue.plays, { trackId, playedAt }] });

/** What goes back to the server: the queue to play there, if a command ran here, and the plays. */
export interface HandBack {
  readonly queue: { readonly trackIds: ReadonlyArray<string>; readonly index: number } | null;
  readonly plays: ReadonlyArray<OfflinePlay>;
}

export const handBack = <T extends Track>(queue: LocalQueue<T>): HandBack => {
  const index = Math.max(0, indexOf(queue, queue.state.current));

  return {
    queue:
      queue.changed && queue.state.entries.length > 0
        ? { trackIds: queue.state.entries.map((entry) => entry.track.id), index }
        : null,
    plays: queue.plays,
  };
};
