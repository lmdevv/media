import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { groupsFor, openKeychains } from "./keychains";
import type { SecureStoreModule, StoreOptions } from "./keychains";
import {
  keychainKey,
  readAppRecord,
  readConnection,
  readPhoneAccount,
  sessionKeyFor,
  writeAppRecord,
  writeConnection,
  writePhoneAccount,
} from "./records";
import type { UserId } from "./records";

interface Call {
  readonly call: string;
  readonly key: string;
  readonly group: string | undefined;
}

/** The keys expo-secure-store 58 takes (`isValidKey` in its `SecureStore.ts`); it throws on any other. */
const SECURE_STORE_KEY = /^[\w.-]+$/u;

/** expo-secure-store 58's `keychainAccessible` values (`SecureStoreAccessible.swift`). */
const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;

const WHEN_UNLOCKED = 5;

interface Item {
  readonly value: string;
  readonly accessible: number;
}

/**
 * expo-secure-store 58 as the keychain behaves (`SecureStoreModule.swift`): items live per access
 * group, and a group the build is not entitled to refuses every call, as iOS does. Lookups ignore
 * the accessibility class. A new item takes the class the call names, or when-unlocked; a write to
 * an existing item keeps its class unless the call names one. While `device.locked`, a
 * when-unlocked item can be neither read nor written. A key outside expo-secure-store's characters
 * is refused before the keychain sees it.
 */
const recordingStore = (entitled: ReadonlySet<string>) => {
  const calls: Array<Call> = [];
  const items = new Map<string, Item>();
  const device = { locked: false };

  const slot = (call: string, key: string, options: StoreOptions): string => {
    calls.push({ call, key, group: options.accessGroup });

    if (!SECURE_STORE_KEY.test(key)) throw new Error("Invalid key provided to SecureStore");

    if (options.accessGroup !== undefined && !entitled.has(options.accessGroup)) {
      throw new Error("errSecMissingEntitlement");
    }

    return `${options.accessGroup ?? "(first listed)"}/${key}`;
  };

  const read = (call: string, key: string, options: StoreOptions): string | null => {
    const item = items.get(slot(call, key, options));

    if (item === undefined) return null;

    if (device.locked && item.accessible === WHEN_UNLOCKED) {
      throw new Error("errSecInteractionNotAllowed");
    }

    return item.value;
  };

  const write = (call: string, key: string, value: string, options: StoreOptions): void => {
    const at = slot(call, key, options);
    const held = items.get(at)?.accessible;
    const accessible = options.keychainAccessible ?? held ?? WHEN_UNLOCKED;

    if (device.locked && (held === WHEN_UNLOCKED || accessible === WHEN_UNLOCKED)) {
      throw new Error("errSecInteractionNotAllowed");
    }

    items.set(at, { value, accessible });
  };

  const store: SecureStoreModule = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    getItem: (key, options) => read("getItem", key, options),
    setItem: (key, value, options) => {
      write("setItem", key, value, options);
    },
    getItemAsync: async (key, options) => read("getItemAsync", key, options),
    setItemAsync: async (key, value, options) => {
      write("setItemAsync", key, value, options);
    },
    deleteItemAsync: async (key, options) => {
      items.delete(slot("deleteItemAsync", key, options));
    },
  };

  /** The class of the item at `key` in `group`. */
  const accessibleAt = (group: string, key: string) => items.get(`${group}/${key}`)?.accessible;

  return { store, calls, device, accessibleAt };
};

const groupOnly = (options: StoreOptions): StoreOptions =>
  options.accessGroup === undefined ? {} : { accessGroup: options.accessGroup };

/** `store` as an older build called it, naming only the access group, so items take the default. */
const olderBuild = (store: SecureStoreModule): SecureStoreModule => ({
  ...store,
  setItem: (key, value, options) => {
    store.setItem(key, value, groupOnly(options));
  },
  setItemAsync: async (key, value, options) => store.setItemAsync(key, value, groupOnly(options)),
});

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
    expect(
      new Set(calls.filter((call) => call.key === "media.phone").map((call) => call.group)),
    ).toEqual(new Set([OWN]));
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

describe("the after-first-unlock class", () => {
  const server = "https://cinema.home/";
  const userId = Brand.nominal<UserId>()("jd7f3k2m9x8b1c4v5n6q0w2e3r4t5y6u");
  const account = { server, userId, grant: "dg_x" };
  const record = { device: "dv_x", person: { userId, username: "aiko" }, opened: true };

  const connection = {
    mediaUrl: server,
    convexUrl: `${server}convex`,
    moviesUrl: `${server}movies`,
  };

  /** Signs Aiko in on `store` the way a build writes its records: the grant, the record, the session. */
  const signIn = async (store: SecureStoreModule) => {
    const launch = openKeychains(store, { own: OWN, shared: SHARED });

    writePhoneAccount(launch.shared, account);
    writeAppRecord(launch.own, server, record);
    writeConnection(launch.own, connection);
    await launch.sessions.setItem(sessionKeyFor(server), "tokens");
  };

  /** Reads back everything sign-in wrote, as a launch does. */
  const readBack = async (store: SecureStoreModule) => {
    const launch = openKeychains(store, { own: OWN, shared: SHARED });

    return {
      account: readPhoneAccount(launch.shared),
      record: readAppRecord(launch.own, server),
      connection: readConnection(launch.own),
      // The SDK treats a session it cannot load as none.
      session: await Promise.resolve()
        .then(async () => launch.sessions.getItem(sessionKeyFor(server)))
        .catch(() => null),
    };
  };

  const signedIn = { account, record, connection, session: "tokens" };

  const KEYS = [
    [SHARED, "media.phone"],
    [OWN, `media.app.${server.replace(/[^\w.-]/gu, "_")}`],
    [OWN, "media.server"],
    [OWN, sessionKeyFor(server)],
  ] as const;

  it("stores every item a build writes after first unlock, so a locked phone reads the sign-in", async () => {
    const { store, device, accessibleAt } = recordingStore(new Set([OWN, SHARED]));

    await signIn(store);

    for (const [group, key] of [...KEYS, [SHARED, "media.probe"] as const]) {
      expect(accessibleAt(group, key)).toBe(AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
    }

    device.locked = true;

    await expect(readBack(store)).resolves.toEqual(signedIn);
  });

  it("keeps an older build's sign-in on update and moves each item to the class on first read", async () => {
    const { store, device, accessibleAt } = recordingStore(new Set([OWN, SHARED]));

    await signIn(olderBuild(store));

    for (const [group, key] of KEYS) expect(accessibleAt(group, key)).toBe(WHEN_UNLOCKED);

    await expect(readBack(store)).resolves.toEqual(signedIn);

    for (const [group, key] of KEYS) {
      expect(accessibleAt(group, key)).toBe(AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
    }

    device.locked = true;

    await expect(readBack(store)).resolves.toEqual(signedIn);
  });

  it("cannot read an older build's items on a locked phone until an unlocked launch moves them", async () => {
    const { store, device } = recordingStore(new Set([OWN, SHARED]));

    await signIn(olderBuild(store));
    device.locked = true;

    await expect(readBack(store)).resolves.toMatchObject({ account: null, connection: null });

    device.locked = false;
    await readBack(store);
    device.locked = true;

    await expect(readBack(store)).resolves.toEqual(signedIn);
  });

  it("rewrites each older item once, not on every launch", async () => {
    const { store, calls } = recordingStore(new Set([OWN, SHARED]));

    await signIn(olderBuild(store));
    const before = calls.length;

    await readBack(store);
    await readBack(store);
    await readBack(store);

    const rewrites = calls
      .slice(before)
      .filter((call) => call.call === "setItem" && KEYS.some(([, key]) => key === call.key))
      .map((call) => call.key);

    expect(rewrites).toHaveLength(KEYS.length);
    expect(new Set(rewrites)).toEqual(new Set(KEYS.map(([, key]) => key)));
  });

  it("starts a session save the SDK makes during a read only after the read moved its item", async () => {
    const { store, calls } = recordingStore(new Set([OWN, SHARED]));

    await signIn(olderBuild(store));

    const launch = openKeychains(store, { own: OWN, shared: SHARED });
    const key = sessionKeyFor(server);
    const before = calls.length;
    const read = launch.sessions.getItem(key);
    const saved = launch.sessions.setItem(key, "renewed tokens");

    await expect(read).resolves.toBe("tokens");
    await saved;

    expect(
      calls
        .slice(before)
        .filter((call) => call.key === key)
        .map((call) => call.call),
    ).toEqual(["getItemAsync", "getItem", "setItem", "setItemAsync"]);
    await expect(launch.sessions.getItem(key)).resolves.toBe("renewed tokens");
  });

  it("never lets a session read's move write over a clear made while the read was away", async () => {
    const { store } = recordingStore(new Set([OWN, SHARED]));

    await signIn(olderBuild(store));

    const reached = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();

    // The keychain has read the session, and the answer has not reached JavaScript yet.
    const slow: SecureStoreModule = {
      ...store,
      getItemAsync: async (key, options) => {
        const value = store.getItem(key, options);

        reached.resolve();
        await answer.promise;

        return value;
      },
    };

    const launch = openKeychains(slow, { own: OWN, shared: SHARED });
    const key = sessionKeyFor(server);
    const read = launch.sessions.getItem(key);

    await reached.promise;
    // A disconnect clears the session synchronously.
    launch.own.write(key, null);
    answer.resolve();

    await expect(read).resolves.toBe("tokens");
    expect(launch.own.read(key)).toBeNull();
  });
});

describe("keychain keys", () => {
  const server = "https://music.home:8443/";
  const userId = Brand.nominal<UserId>()("jd7f3k2m9x8b1c4v5n6q0w2e3r4t5y6u");

  it("builds keys expo-secure-store takes from a real server address and user id", () => {
    const key = keychainKey("music.offlinePlays", server, userId);

    expect(key).toMatch(SECURE_STORE_KEY);
    expect(key.length).toBeLessThan(256);
    expect(sessionKeyFor(server)).toMatch(SECURE_STORE_KEY);
  });

  it("gives distinct servers and people distinct keys, each one expo-secure-store takes", () => {
    const servers = [
      "https://media.home/music/a",
      "https://media.home/music_a",
      "https://media.home/music.a",
      "https://media.home/music-a",
      "https://media.home:8443/music/a",
      "https://media.home/music/a/",
      "https://Media.home/music/a",
      "http://media.home/music/a",
      "https://media.home/música/a",
      "https://media.home/music/a?x=1",
      "https://media.home/music/a.",
      "https://media.home",
      "",
    ];

    const users = [userId, "jd7f3k2m9x8b1c4v5n6q0w2e3r4t5y6v", "a.b", "a", "", "a_b"];

    const pairs = servers.flatMap((one) => users.map((user) => ({ one, user })));
    const keys = pairs.map(({ one, user }) => keychainKey("music.offlinePlays", one, user));

    for (const key of keys) expect(key).toMatch(SECURE_STORE_KEY);
    expect(new Set(keys).size).toBe(pairs.length);
    // A dot inside a part never moves the boundary between parts.
    expect(keychainKey("n", "a.b", "c")).not.toBe(keychainKey("n", "a", "b.c"));
  });

  it("keeps every record mobile-core writes, so a relaunch reads it back", async () => {
    const { store } = recordingStore(new Set([OWN, SHARED]));
    const launch = openKeychains(store, { own: OWN, shared: SHARED });

    const connection = {
      mediaUrl: server,
      convexUrl: `${server}convex`,
      moviesUrl: `${server}movies`,
    };

    const record = { device: "dv_x", person: { userId, username: "aiko" }, opened: true };

    writePhoneAccount(launch.shared, { server, userId, grant: "dg_x" });
    writeAppRecord(launch.own, server, record);
    writeConnection(launch.own, connection);
    await launch.sessions.setItem(sessionKeyFor(server), "tokens");

    const relaunch = openKeychains(store, { own: OWN, shared: SHARED });

    expect(readPhoneAccount(relaunch.shared)).toEqual({ server, userId, grant: "dg_x" });
    expect(readAppRecord(relaunch.own, server)).toEqual(record);
    expect(readConnection(relaunch.own)).toEqual(connection);
    await expect(relaunch.sessions.getItem(sessionKeyFor(server))).resolves.toBe("tokens");
  });
});

describe("groupsFor", () => {
  it("names the app's private group and the shared one under the Team ID", () => {
    expect(groupsFor("J9DZZ82K23", "dev.lmdevv.movies")).toEqual({ own: OWN, shared: SHARED });
    expect(groupsFor(null, "dev.lmdevv.movies")).toEqual({ own: null, shared: null });
  });
});
