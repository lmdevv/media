/**
 * One origin's `localStorage` as several browser tabs see it, for tests of clients that share it.
 * The browser keeps one order of writes. A tab learns of another tab's write through a `storage`
 * event that arrives as a later task, here only when `deliver` runs, and never of its own writes.
 * Tabs in one process read the shared items at once. Tabs in separate processes each read their
 * own copy, which takes in the other tabs' writes, in order, only when they are delivered, so a
 * tab can act on what it has not seen yet. `hold` makes a tab's reads settle late, as an
 * asynchronous store's would, so another tab can write between a read and the write after it.
 */
import type { KeyValueStore } from "../token-storage";

/** The tabs, the browser's own copy of the items, and the controls over when tabs catch up. */
export interface BrowserTabs {
  readonly tab: (index: number) => KeyValueStore;
  /** What the browser holds now, every tab's writes applied. */
  readonly items: ReadonlyMap<string, string>;
  /**
   * Brings tab `index`, or every tab, up to date: separate processes take in the writes they
   * missed, then each write by another tab fires that tab's `storage` listeners.
   */
  readonly deliver: (index?: number) => void;
  /**
   * From now on, each read by tab `index` of a key `holds` accepts takes its value at once but
   * settles only on the returned release, which settles every held read in order.
   */
  readonly hold: (index: number, holds: (key: string) => boolean) => () => void;
  /** While on, every `setItem` throws as a full `localStorage` does; removing still works. */
  readonly fill: (full: boolean) => void;
  /** How many writes the browser has applied. */
  readonly writes: () => number;
  /** How many of the browser's writes tab `index` can read. */
  readonly seen: (index: number) => number;
}

interface Write {
  readonly by: number;
  readonly key: string;
  readonly value: string | null;
}

interface Listener {
  readonly key: string;
  readonly onChange: () => void;
}

const affects = (listener: Listener, key: string): boolean =>
  key === listener.key || key.startsWith(`${listener.key}:`);

/** `count` tabs over an empty origin. With `at once`, every write reaches the others at once. */
export const makeBrowserTabs = (options: {
  readonly count: number;
  readonly processes: "shared" | "separate";
  readonly delivery: "manual" | "at once";
}): BrowserTabs => {
  const items = new Map<string, string>();
  const log: Array<Write> = [];
  const indices = Array.from({ length: options.count }, (_, index) => index);
  const views = indices.map(() => new Map<string, string>());
  const delivered = indices.map(() => 0);
  const listeners = indices.map(() => new Set<Listener>());

  const held = indices.map(
    (): { readonly holds: (key: string) => boolean; readonly waiting: Array<() => void> } | null =>
      null,
  );

  const viewOf = (index: number): Map<string, string> =>
    options.processes === "shared" ? items : (views[index] ?? items);

  const apply = (map: Map<string, string>, write: Write) => {
    if (write.value === null) map.delete(write.key);
    else map.set(write.key, write.value);
  };

  const deliverTo = (index: number) => {
    const pending = log.slice(delivered[index]);

    delivered[index] = log.length;

    if (options.processes === "separate") {
      for (const write of pending) apply(viewOf(index), write);
    }

    for (const write of pending) {
      if (write.by === index) continue;

      for (const listener of listeners[index] ?? []) {
        if (affects(listener, write.key)) listener.onChange();
      }
    }
  };

  const deliver = (index?: number) => {
    for (const each of index === undefined ? indices : [index]) deliverTo(each);
  };

  let full = false;

  const write = (by: number, key: string, value: string | null) => {
    if (full && value !== null) throw new Error("QuotaExceededError: the quota has been exceeded");

    const entry = { by, key, value };

    apply(items, entry);

    if (options.processes === "separate") apply(viewOf(by), entry);
    log.push(entry);

    if (options.delivery === "at once") deliver();
  };

  const tab = (index: number): KeyValueStore => ({
    getItem: (key) => {
      const value = viewOf(index).get(key) ?? null;
      const holding = held[index];

      if (holding === null || holding === undefined || !holding.holds(key)) return value;

      return new Promise((resolve) => {
        holding.waiting.push(() => resolve(value));
      });
    },
    setItem: (key, value) => write(index, key, value),
    keys: () => [...viewOf(index).keys()],
    removeItem: (key) => write(index, key, null),
    subscribe: (key, onChange) => {
      const listener = { key, onChange };

      listeners[index]?.add(listener);

      return () => {
        listeners[index]?.delete(listener);
      };
    },
  });

  return {
    tab,
    items,
    deliver,
    fill: (next) => {
      full = next;
    },
    writes: () => log.length,
    seen: (index) => (options.processes === "shared" ? log.length : (delivered[index] ?? 0)),
    hold: (index, holds) => {
      const waiting: Array<() => void> = [];

      held[index] = { holds, waiting };

      return () => {
        held[index] = null;

        for (const settle of waiting.splice(0)) settle();
      };
    },
  };
};
