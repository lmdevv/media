import { openIndexedDb, readDevice } from "@media/sdk/promise";
import type { BrowserDevice, SharedStore } from "@media/sdk/promise";

/**
 * This browser's one session and device, which every client on the origin shares (ADR 0020). The
 * SDK owns the record; this store only tells React which device the browser keeps.
 */
export interface BrowserStore {
  /**
   * The SDK's session store in IndexedDB. Without IndexedDB it refuses every read and write, so
   * the client loads no session and signs no one in.
   */
  readonly sessions: SharedStore;
  /** The device as last read; the same object until it changes. */
  readonly device: () => BrowserDevice | null;
  /** Calls `onChange` after the device changes, here or in another tab. */
  readonly subscribe: (onChange: () => void) => () => void;
}

const UNAVAILABLE = () =>
  Promise.reject(
    new Error("This browser can't keep a sign-in right now. Reload the page to try again."),
  );

const unavailable: SharedStore = {
  read: UNAVAILABLE,
  write: UNAVAILABLE,
  subscribe: () => () => undefined,
};

const sameDevice = (a: BrowserDevice | null, b: BrowserDevice | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.id === b.id && a.code === b.code && a.sequence === b.sequence);

/**
 * The browser's store over `shared`, read once before it returns. Without IndexedDB (`null`) it
 * holds nothing and every change fails, so the browser shows signed out.
 */
export const openBrowserStore = async (shared: SharedStore | null): Promise<BrowserStore> => {
  const sessions = shared ?? unavailable;
  const listeners = new Set<() => void>();
  const read = () => readDevice(sessions).catch(() => null);
  let current = await read();

  const refresh = async () => {
    const next = await read();

    if (sameDevice(current, next)) return;
    current = next;

    for (const listener of listeners) listener();
  };

  sessions.subscribe(() => {
    void refresh();
  });

  return {
    sessions,
    device: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
  };
};

/**
 * Opens the origin's shared session store: IndexedDB, whose transactions run one at a time across
 * tabs and work over plain HTTP, with a `BroadcastChannel` telling the other tabs to read again.
 * Every client on the origin (`/`, `/movies`, `/music`) opens the same one, so one sign-in serves
 * them all. Without IndexedDB the browser keeps no sign-in rather than falling back to
 * `localStorage`.
 */
export const openBrowserSession = async (): Promise<BrowserStore> => {
  const shared = await openIndexedDb({
    indexedDB: window.indexedDB,
    name: "media",
    channel: (name, onMessage) => {
      const channel = new BroadcastChannel(name);
      const announce = channel.postMessage.bind(channel);

      channel.addEventListener("message", onMessage);

      return { post: () => announce("changed"), close: () => channel.close() };
    },
  }).catch(() => null);

  return openBrowserStore(shared);
};
