/**
 * Browser tabs of one origin sharing IndexedDB, for tests of clients that share a session store.
 * Every tab opens its own connection to one fake-indexeddb database, so transactions serialize
 * across tabs as they do in a browser. A tab hears of another tab's commit only when `deliver`
 * runs, the way a `BroadcastChannel` message arrives as a later task, unless delivery is `at once`.
 * `fill` makes writes fail as a full store does, rolling their transaction back.
 */
import { openIndexedDb } from "@media/sdk/promise";
import type { Channel, SharedStore } from "@media/sdk/promise";
import { IDBFactory } from "fake-indexeddb";

/** The tabs and the controls over what they hear and whether writes fit. */
export interface BrowserTabs {
  readonly tab: (index: number) => SharedStore;
  /** Every key and value the database holds now. */
  readonly items: () => Promise<ReadonlyMap<string, string>>;
  /** Hands tab `index`, or every tab, the notifications other tabs sent it so far. */
  readonly deliver: (index?: number) => void;
  /** While on, every write that sets a value fails and rolls back; removing still works. */
  readonly fill: (full: boolean) => void;
}

const NAME = "media";

/** `count` tabs over an empty database. */
export const makeBrowserTabs = async (options: {
  readonly count: number;
  readonly delivery: "manual" | "at once";
}): Promise<BrowserTabs> => {
  const indexedDB = new IDBFactory();
  const indices = Array.from({ length: options.count }, (_, index) => index);
  const queued = indices.map((): Array<() => void> => []);
  const listeners: Array<() => void> = [];
  let full = false;

  const deliverTo = (index: number) => {
    for (const notify of queued[index]?.splice(0) ?? []) notify();
  };

  const deliver = (index?: number) => {
    for (const each of index === undefined ? indices : [index]) deliverTo(each);
  };

  const channelFor =
    (index: number) =>
    (_name: string, onMessage: () => void): Channel => {
      listeners[index] = onMessage;

      return {
        post: () => {
          for (const other of indices) {
            if (other !== index) queued[other]?.push(() => listeners[other]?.());
          }

          if (options.delivery === "at once") deliver();
        },
        close: () => undefined,
      };
    };

  const opened = await Promise.all(
    indices.map((index) => openIndexedDb({ indexedDB, name: NAME, channel: channelFor(index) })),
  );

  const tab = (index: number): SharedStore => {
    const store = opened[index];

    if (store === undefined) throw new Error(`No tab ${index}`);

    return {
      read: store.read,
      subscribe: store.subscribe,
      write: (run) =>
        store.write((tx) =>
          run({
            ...tx,
            set: async (key, value) => {
              if (full) throw new Error("QuotaExceededError: the quota has been exceeded");
              await tx.set(key, value);
            },
          }),
        ),
    };
  };

  return {
    tab,
    items: () =>
      tab(0).read(async (tx) => {
        const keys = await tx.keys();

        const values = await Promise.all(
          keys.map(async (key) => [key, await tx.get(key)] as const),
        );

        return new Map(
          values.flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const])),
        );
      }),
    deliver,
    fill: (next) => {
      full = next;
    },
  };
};
