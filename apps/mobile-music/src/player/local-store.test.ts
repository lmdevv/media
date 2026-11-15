import { openKeychains } from "@media/mobile-core/keychains";
import type { SecureStoreModule, StoreOptions } from "@media/mobile-core/keychains";
import { describe, expect, it } from "vitest";

import { recordPlay } from "./local-queue";
import { LocalStore, offlinePlaysKey } from "./local-store";

/** The keys expo-secure-store 58 takes (`isValidKey` in its `SecureStore.ts`); it throws on any other. */
const SECURE_STORE_KEY = /^[\w.-]+$/u;

const OWN = "J9DZZ82K23.dev.lmdevv.music";

const SERVER = "https://music.home:8443";

const PERSON = "jd7f3k2m9x8b1c4v5n6q0w2e3r4t5y6u";

/** Where `key` lives, after expo-secure-store's own key check. */
const slot = (key: string, options: StoreOptions): string => {
  if (!SECURE_STORE_KEY.test(key)) {
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".',
    );
  }

  return `${options.accessGroup ?? ""}/${key}`;
};

/** The phone's keychain as expo-secure-store reaches it: items outlive the app, bad keys throw. */
const keychainStore = (): SecureStoreModule => {
  const items = new Map<string, string>();

  return {
    getItem: (key, options) => items.get(slot(key, options)) ?? null,
    setItem: (key, value, options) => {
      items.set(slot(key, options), value);
    },
    getItemAsync: async (key, options) => items.get(slot(key, options)) ?? null,
    setItemAsync: async (key, value, options) => {
      items.set(slot(key, options), value);
    },
    deleteItemAsync: async (key, options) => {
      items.delete(slot(key, options));
    },
  };
};

/** The app's own keychain on one launch. */
const launch = (store: SecureStoreModule) => openKeychains(store, { own: OWN, shared: null }).own;

describe("offline plays", () => {
  it("keeps them under a key expo-secure-store takes, for a real server and user id", () => {
    expect(offlinePlaysKey(SERVER, PERSON)).toMatch(SECURE_STORE_KEY);
    expect(offlinePlaysKey(`${SERVER}/`, PERSON)).toMatch(SECURE_STORE_KEY);
  });

  it("keeps the plays of servers whose addresses differ only in punctuation apart", () => {
    const store = keychainStore();

    new LocalStore(launch(store), offlinePlaysKey("https://media.home/music/a", PERSON)).update(
      (queue) => recordPlay(queue, "t-a", 1000),
    );

    expect(
      new LocalStore(
        launch(store),
        offlinePlaysKey("https://media.home/music_a", PERSON),
      ).getSnapshot().plays,
    ).toEqual([]);
  });

  it("keeps them through a relaunch until they reach the server", () => {
    const store = keychainStore();
    const key = offlinePlaysKey(SERVER, PERSON);
    const first = new LocalStore(launch(store), key);

    first.update((queue) => recordPlay(recordPlay(queue, "t-a", 1000), "t-b", 2000));

    const second = new LocalStore(launch(store), key);

    expect(second.getSnapshot().plays).toEqual([
      { trackId: "t-a", playedAt: 1000 },
      { trackId: "t-b", playedAt: 2000 },
    ]);

    second.update((queue) => ({ ...queue, plays: [] }));

    expect(new LocalStore(launch(store), key).getSnapshot().plays).toEqual([]);
  });

  it("keeps each server's and person's plays apart", () => {
    const store = keychainStore();

    new LocalStore(launch(store), offlinePlaysKey(SERVER, PERSON)).update((queue) =>
      recordPlay(queue, "t-a", 1000),
    );

    expect(
      new LocalStore(launch(store), offlinePlaysKey("https://other.home", PERSON)).getSnapshot()
        .plays,
    ).toEqual([]);
    expect(
      new LocalStore(
        launch(store),
        offlinePlaysKey(SERVER, "kd7f3k2m9x8b1c4v5n6q0w2e3r4t5y6u"),
      ).getSnapshot().plays,
    ).toEqual([]);
  });
});
