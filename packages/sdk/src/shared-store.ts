/**
 * A string store that several clients of one origin share, such as the tabs of a browser, with
 * transactions: each runs alone, so a check and the write it guards never interleave with another
 * client's. The browser's is IndexedDB, whose readwrite transactions on one object store run one
 * at a time across every tab and work outside secure contexts. Notifications only tell clients to
 * read again; they never carry what changed.
 */

import { Option, Schema } from "effect";

/** The reads and writes of one transaction. */
export interface SharedTransaction {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly keys: () => Promise<ReadonlyArray<string>>;
}

/** A shared store: transactions, and a call after any client's committed write. */
export interface SharedStore {
  /** Runs `run` as one read-only transaction. */
  readonly read: <A>(run: (tx: SharedTransaction) => Promise<A>) => Promise<A>;
  /**
   * Runs `run` as one readwrite transaction, which commits whole or not at all; a rejection from
   * `run` rolls it back.
   */
  readonly write: <A>(run: (tx: SharedTransaction) => Promise<A>) => Promise<A>;
  /** Calls `onChange` after any client's write commits, this one's included; returns the stop. */
  readonly subscribe: (onChange: () => void) => () => void;
}

/** An IndexedDB object's way to hear an event, as far as this store uses it. */
interface IdbEvents<Type extends string> {
  addEventListener(type: Type, listener: () => void): void;
}

/** The part of an IndexedDB request this store uses. */
interface IdbRequest<T> extends IdbEvents<"success" | "error"> {
  readonly result: T;
  readonly error: unknown;
}

interface IdbObjectStore {
  get(key: string): IdbRequest<unknown>;
  put(value: string, key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
  getAllKeys(): IdbRequest<ReadonlyArray<unknown>>;
}

interface IdbTransaction extends IdbEvents<"complete" | "abort"> {
  readonly error: unknown;
  objectStore(name: string): IdbObjectStore;
  abort(): void;
}

interface IdbDatabase extends IdbEvents<"versionchange"> {
  readonly objectStoreNames: { contains(name: string): boolean };
  transaction(store: string, mode: "readonly" | "readwrite"): IdbTransaction;
  createObjectStore(name: string): void;
  close(): void;
}

interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  addEventListener(type: "success" | "error" | "upgradeneeded", listener: () => void): void;
}

/** The part of `indexedDB` this store uses, so the SDK needs no DOM types. */
export interface IdbFactory {
  open(name: string, version?: number): IdbOpenRequest;
}

/** A channel to the origin's other clients, such as a `BroadcastChannel`, opened per store. */
export interface Channel {
  /** Tells every other client that a write committed. */
  readonly post: () => void;
  readonly close: () => void;
}

const STORE = "kv";

/** Values and keys come back from IndexedDB untyped; this store only ever writes strings. */
const asString = Schema.decodeUnknownOption(Schema.String);

const VERSION = 1;

const settle = <T>(request: IdbRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    });

    request.addEventListener("error", () => {
      reject(request.error);
    });
  });

const opened = (factory: IdbFactory, name: string): Promise<IdbDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);

    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    });

    request.addEventListener("success", () => {
      resolve(request.result);
    });

    request.addEventListener("error", () => {
      reject(request.error);
    });
  });

/**
 * Opens the shared store `name` in `indexedDB`, with `channel` telling the other clients when a
 * write commits. Rejects when IndexedDB cannot open it, as in some private modes.
 */
export const openIndexedDb = async (options: {
  readonly indexedDB: IdbFactory;
  readonly name: string;
  /** Opens the channel `name`, calling `onMessage` for every other client's post. */
  readonly channel: (name: string, onMessage: () => void) => Channel;
}): Promise<SharedStore> => {
  const db = await opened(options.indexedDB, options.name);
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const channel = options.channel(options.name, notify);

  db.addEventListener("versionchange", () => {
    db.close();
    channel.close();
  });

  const transact = <A>(
    mode: "readonly" | "readwrite",
    run: (tx: SharedTransaction) => Promise<A>,
  ): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let outcome: { readonly value: A } | null = null;
      let failure: { readonly cause: unknown } | null = null;

      const ops: SharedTransaction = {
        get: async (key) => Option.getOrUndefined(asString(await settle(store.get(key)))),
        set: async (key, value) => {
          await settle(store.put(value, key));
        },
        remove: async (key) => {
          await settle(store.delete(key));
        },
        keys: async () =>
          (await settle(store.getAllKeys())).flatMap((key) => Option.toArray(asString(key))),
      };

      tx.addEventListener("complete", () => {
        if (failure !== null || outcome === null) {
          reject(failure?.cause ?? new Error("The transaction ended before its work did"));

          return;
        }

        if (mode === "readwrite") {
          channel.post();
          notify();
        }

        resolve(outcome.value);
      });

      tx.addEventListener("abort", () => {
        reject(failure?.cause ?? tx.error);
      });

      void (async () => {
        try {
          outcome = { value: await run(ops) };
        } catch (cause) {
          failure = { cause };

          try {
            tx.abort();
          } catch {
            // The transaction already ended, and its `complete` or `abort` reports the failure.
          }
        }
      })();
    });

  return {
    read: (run) => transact("readonly", run),
    write: (run) => transact("readwrite", run),
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
  };
};
