/**
 * The details of the songs a music group session shows: the core's session answers only which
 * song each entry is, so a player reads each song's details, as a long queue does row by row.
 */

/** A followed query's state, as the SDK's `watch` answers it. */
type Watched<T> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error" };

/** A followed query, as the SDK's `QueryWatch` is. */
export interface TrackWatch<T> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => Watched<T>;
}

interface Shelved<T> {
  readonly watch: TrackWatch<T>;
  readonly stop: () => void;
}

/**
 * Follows the details of the songs asked for, and only those: `music.tracks.get` per song, live,
 * so a like shows at once. A song whose details fail to load, as one this person may not see,
 * reads as null.
 */
export class TrackShelf<T> {
  readonly #watchOf: (trackId: string) => TrackWatch<T>;
  readonly #listeners = new Set<() => void>();
  readonly #shelved = new Map<string, Shelved<T>>();
  #snapshot: ReadonlyMap<string, T | null> = new Map();

  constructor(watchOf: (trackId: string) => TrackWatch<T>) {
    this.#watchOf = watchOf;
  }

  /** The details known so far: a song, or null when it failed; absent while it loads. */
  getSnapshot = (): ReadonlyMap<string, T | null> => this.#snapshot;

  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Follows the songs `trackIds` from now on, and stops following every other. */
  want(trackIds: ReadonlyArray<string>): void {
    const wanted = new Set(trackIds);
    let changed = false;

    for (const [trackId, shelved] of this.#shelved) {
      if (wanted.has(trackId)) continue;

      shelved.stop();
      this.#shelved.delete(trackId);
      changed = true;
    }

    for (const trackId of wanted) {
      if (this.#shelved.has(trackId)) continue;

      const watch = this.#watchOf(trackId);

      const stop = watch.subscribe(() => {
        this.#publish();
      });

      this.#shelved.set(trackId, { watch, stop });
      changed = true;
    }

    if (changed) this.#publish();
  }

  /** Stops following every song. */
  clear(): void {
    this.want([]);
  }

  #publish(): void {
    const next = new Map<string, T | null>();

    for (const [trackId, { watch }] of this.#shelved) {
      const state = watch.getSnapshot();

      if (state.status === "success") next.set(trackId, state.data);
      else if (state.status === "error") next.set(trackId, null);
    }

    const same =
      next.size === this.#snapshot.size &&
      [...next].every(([trackId, track]) => this.#snapshot.get(trackId) === track);

    if (same) return;

    this.#snapshot = next;

    for (const listener of this.#listeners) listener();
  }
}
