import { describe, expect, it } from "vitest";

import { groupsFor, openKeychains } from "./keychains";
import type { SecureStoreModule, StoreOptions } from "./keychains";

interface Call {
  readonly call: string;
  readonly key: string;
  readonly group: string | undefined;
}

/**
 * expo-secure-store as the keychain behaves: items live per access group, and a group the build
 * is not entitled to refuses every call, as iOS does.
 */
const recordingStore = (entitled: ReadonlySet<string>) => {
  const calls: Array<Call> = [];
  const items = new Map<string, string>();

  const slot = (call: string, key: string, options: StoreOptions): string => {
    calls.push({ call, key, group: options.accessGroup });

    if (options.accessGroup !== undefined && !entitled.has(options.accessGroup)) {
      throw new Error("errSecMissingEntitlement");
    }

    return `${options.accessGroup ?? "(first listed)"}/${key}`;
  };

  const store: SecureStoreModule = {
    getItem: (key, options) => items.get(slot("getItem", key, options)) ?? null,
    setItem: (key, value, options) => {
      items.set(slot("setItem", key, options), value);
    },
    getItemAsync: async (key, options) => items.get(slot("getItemAsync", key, options)) ?? null,
    setItemAsync: async (key, value, options) => {
      items.set(slot("setItemAsync", key, options), value);
    },
    deleteItemAsync: async (key, options) => {
      items.delete(slot("deleteItemAsync", key, options));
    },
  };

  return { store, calls };
};

const OWN = "J9DZZ82K23.dev.lmdevv.movies";

const SHARED = "J9DZZ82K23.dev.lmdevv.media";

describe("openKeychains", () => {
  it("names the private group on every own read and write, and the shared group on every shared one", async () => {
    const { store, calls } = recordingStore(new Set([OWN, SHARED]));
    const keychains = openKeychains(store, { own: OWN, shared: SHARED });

    keychains.own.write("media.app.x", "record");
    keychains.own.read("media.app.x");
    await keychains.sessions.setItem("media.session.x", "tokens");
    await keychains.sessions.getItem("media.session.x");
    await keychains.sessions.removeItem("media.session.x");
    keychains.shared.write("media.phone", "grant");
    keychains.shared.read("media.phone");

    const groupOf = (prefix: string) =>
      new Set(calls.filter((call) => call.key.startsWith(prefix)).map((call) => call.group));

    expect(groupOf("media.app")).toEqual(new Set([OWN]));
    expect(groupOf("media.session")).toEqual(new Set([OWN]));
    expect(groupOf("media.phone")).toEqual(new Set([SHARED]));
    expect(calls.some((call) => call.group === undefined)).toBe(false);
    expect(keychains.sharesWithApps).toBe(true);
  });

  it("keeps a session out of the shared group, so another app on the phone never reads it", async () => {
    const { store } = recordingStore(new Set([OWN, SHARED]));
    const movies = openKeychains(store, { own: OWN, shared: SHARED });
    const music = openKeychains(store, { own: "J9DZZ82K23.dev.lmdevv.music", shared: SHARED });

    await movies.sessions.setItem("media.session.x", "movies tokens");
    movies.shared.write("media.phone", "grant");

    expect(music.shared.read("media.phone")).toBe("grant");
    await expect(music.sessions.getItem("media.session.x")).rejects.toThrow();
  });

  it("keeps the shared record in the private group when the build cannot write the shared one", () => {
    const { store, calls } = recordingStore(new Set([OWN]));
    const keychains = openKeychains(store, { own: OWN, shared: SHARED });

    keychains.shared.write("media.phone", "grant");

    expect(keychains.sharesWithApps).toBe(false);
    expect(keychains.shared.read("media.phone")).toBe("grant");
    expect(calls.filter((call) => call.key === "media.phone").map((call) => call.group)).toEqual([
      OWN,
      OWN,
    ]);
  });

  it("throws on a refused durable write and holds nothing, not even over an earlier held value", () => {
    const { store } = recordingStore(new Set());
    const keychains = openKeychains(store, { own: OWN, shared: null });

    keychains.own.write("media.app.x", "held");

    expect(() => keychains.own.writeDurably("media.app.x", "mark")).toThrow(
      expect.objectContaining({ _tag: "KeychainWriteFailed", key: "media.app.x" }),
    );
    expect(keychains.own.read("media.app.x")).toBeNull();
  });

  it("holds a refused write for the launch", () => {
    const { store } = recordingStore(new Set());
    const keychains = openKeychains(store, { own: OWN, shared: null });

    keychains.own.write("media.server", "connection");

    expect(keychains.own.read("media.server")).toBe("connection");
  });
});

describe("groupsFor", () => {
  it("names the app's private group and the shared one under the Team ID", () => {
    expect(groupsFor("J9DZZ82K23", "dev.lmdevv.movies")).toEqual({ own: OWN, shared: SHARED });
    expect(groupsFor(null, "dev.lmdevv.movies")).toEqual({ own: null, shared: null });
  });
});
