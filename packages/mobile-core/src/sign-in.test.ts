import { Conflict, Unauthenticated } from "@media/contracts/errors";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { memoryKeychain } from "./keychain";
import { openKeychains } from "./keychains";
import type { SecureStoreModule, StoreOptions } from "./keychains";
import type { Keychain } from "./keychain";
import { readAppRecord, readPhoneAccount } from "./records";
import type { UserId } from "./records";
import {
  lastPerson,
  setUpOwner,
  signInOnLaunch,
  signInWithPassword,
  startDeviceSignIn,
} from "./sign-in";
import type { Phone, SignInPlatform } from "./sign-in";

const SERVER = "http://cinema.test";

type Devices = SignInPlatform["core"]["devices"];

const asUserId = Brand.nominal<UserId>();

const asGrantId = Brand.nominal<Awaited<ReturnType<Devices["deviceGrants"]["issue"]>>["grantId"]>();

const asDeviceId = Brand.nominal<Awaited<ReturnType<Devices["registry"]["enroll"]>>["deviceId"]>();

interface Grant {
  readonly userId: UserId;
  readonly secret: string;
}

/**
 * The core's side of signing in, kept in memory with the rules ADR 0006 states: a password session
 * issues; a stored grant of the caller's is confirmed, another person's is revoked first (D64);
 * an exchange needs a live grant of that person; each app's device keeps its code.
 */
const refused = () => new Unauthenticated({ message: "refused" });

const fakeCore = () => {
  const passwords = new Map<string, { readonly userId: UserId; readonly password: string }>([
    ["aiko", { userId: asUserId("u_aiko"), password: "aiko-password" }],
    ["mateo", { userId: asUserId("u_mateo"), password: "mateo-password" }],
  ]);

  const grants = new Map<string, Grant>();
  const revoked: Array<string> = [];
  const enrolled: Array<{ readonly name: string; readonly device: string | undefined }> = [];
  let hasOwner = true;

  let current: {
    readonly userId: UserId;
    readonly username: string;
    readonly kind: string;
  } | null = null;

  let failEnroll = false;
  let serial = 0;

  const signedIn = (username: string, kind: string) => {
    const account = passwords.get(username);

    if (account === undefined) throw refused();
    current = { userId: account.userId, username, kind };
  };

  const platform = (calls: Array<string>): SignInPlatform => ({
    session: {
      signInWithPassword: async ({ username, password }) => {
        calls.push("password");

        if (passwords.get(username)?.password !== password) throw refused();
        signedIn(username, "password");
      },
      setUpOwner: async ({ username, password }) => {
        calls.push("setup");

        if (hasOwner) throw new Conflict({ message: "has an owner" });
        hasOwner = true;
        passwords.set(username, { userId: asUserId(`u_${username}`), password });
        signedIn(username, "password");
      },
      acceptInvite: async () => {
        calls.push("invite");
      },
      exchangeGrant: async ({ userId, grant }) => {
        calls.push("exchange");

        const [id = "", secret] = grant.split(".");
        const held = grants.get(id);

        if (held === undefined || held.userId !== userId || held.secret !== secret) throw refused();

        const username = [...passwords].find(([, account]) => account.userId === userId)?.[0];

        if (username === undefined) throw refused();
        signedIn(username, "grant");
      },
      signOut: async () => {
        calls.push("signOut");
        current = null;
      },
      startDeviceSignIn: async (clientName) => {
        calls.push(`deviceCode:${clientName}`);

        return {
          userCode: "ABCD-EFGH",
          expiresAt: 0,
          complete: async () => signedIn("mateo", "deviceCode"),
        };
      },
    },
    core: {
      auth: {
        sessions: {
          current: async () => {
            if (current === null) throw refused();

            return { userId: current.userId, username: current.username };
          },
        },
      },
      devices: {
        deviceGrants: {
          issue: async ({ grant }) => {
            calls.push(`issue:${grant ?? "none"}`);

            if (current === null || current.kind !== "password") throw refused();

            const [id = "", secret] = (grant ?? "").split(".");
            const held = grants.get(id);

            if (held !== undefined && held.secret === secret) {
              if (held.userId === current.userId) {
                return { grantId: asGrantId(id), grant: `${id}.${held.secret}` };
              }

              grants.delete(id);
              revoked.push(id);
            }

            serial += 1;
            const next = `dg_${serial}`;

            grants.set(next, { userId: current.userId, secret: `secret${serial}` });

            return { grantId: asGrantId(next), grant: `${next}.secret${serial}` };
          },
        },
        registry: {
          enroll: async ({ name, device }) => {
            calls.push("enroll");
            enrolled.push({ name, device });

            if (failEnroll) throw new Conflict({ message: "no" });
            serial += 1;

            return {
              deviceId: asDeviceId(`d_${serial}`),
              device: device ?? `dv_${serial}`,
              joinSequence: serial,
            };
          },
        },
      },
    },
  });

  return {
    platform,
    grants,
    revoked,
    enrolled,
    current: () => current,
    noOwner: () => {
      hasOwner = false;
    },
    failEnrollments: () => {
      failEnroll = true;
    },
  };
};

const phoneWith = (shared: Keychain, own: Keychain = memoryKeychain()): Phone => ({
  own,
  shared,
  server: SERVER,
  deviceName: "Aiko's iPhone",
});

describe("signInWithPassword", () => {
  it("issues the phone's grant, keeps it in the shared keychain, and enrolls the app", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const phone = phoneWith(memoryKeychain());

    await signInWithPassword(core.platform(calls), phone, {
      username: "aiko",
      password: "aiko-password",
    });

    expect(calls).toEqual(["password", "enroll", "issue:none"]);
    expect(readPhoneAccount(phone.shared)).toEqual({
      server: SERVER,
      userId: "u_aiko",
      grant: "dg_2.secret2",
    });
    expect(readAppRecord(phone.own, SERVER)).toEqual({
      device: "dv_1",
      person: { userId: "u_aiko", username: "aiko" },
      opened: true,
    });
  });

  it("confirms the person's own grant and enrolls with the app's device code again", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const phone = phoneWith(memoryKeychain());
    const aiko = { username: "aiko", password: "aiko-password" };

    await signInWithPassword(core.platform(calls), phone, aiko);
    await signInWithPassword(core.platform(calls), phone, aiko);

    expect(calls.slice(3)).toEqual(["password", "enroll", "issue:dg_2.secret2"]);
    expect(core.revoked).toEqual([]);
    expect(readPhoneAccount(phone.shared)?.grant).toBe("dg_2.secret2");
    expect(core.enrolled.at(-1)?.device).toBe("dv_1");
  });

  it("revokes the grant another person holds on the phone when a second person signs in (D64)", async () => {
    const core = fakeCore();
    const shared = memoryKeychain();
    const movies = phoneWith(shared);

    await signInWithPassword(core.platform([]), movies, {
      username: "aiko",
      password: "aiko-password",
    });

    const calls: Array<string> = [];

    await signInWithPassword(core.platform(calls), movies, {
      username: "mateo",
      password: "mateo-password",
    });

    expect(calls).toEqual(["password", "enroll", "issue:dg_2.secret2"]);
    expect(core.revoked).toEqual(["dg_2"]);
    expect(readPhoneAccount(shared)).toEqual({
      server: SERVER,
      userId: "u_mateo",
      grant: "dg_4.secret4",
    });

    // The phone's second app, still holding nothing of its own, now finds only Mateo's grant.
    const music = phoneWith(shared);

    expect(await signInOnLaunch(core.platform([]), music)).toBe("exchanged");
    expect(core.current()?.username).toBe("mateo");
  });

  it("hands over no grant kept for another server", async () => {
    const core = fakeCore();
    const shared = memoryKeychain();
    const calls: Array<string> = [];

    await signInWithPassword(
      core.platform([]),
      { ...phoneWith(shared), server: "http://other.test" },
      { username: "aiko", password: "aiko-password" },
    );
    await signInWithPassword(core.platform(calls), phoneWith(shared), {
      username: "mateo",
      password: "mateo-password",
    });

    expect(calls).toContain("issue:none");
    expect(readPhoneAccount(shared)?.server).toBe(SERVER);
  });

  it("keeps the phone untouched and signs the session out when the password is refused", async () => {
    const core = fakeCore();
    const phone = phoneWith(memoryKeychain());

    await expect(
      signInWithPassword(core.platform([]), phone, { username: "aiko", password: "wrong" }),
    ).rejects.toMatchObject({ _tag: "Unauthenticated" });
    expect(readPhoneAccount(phone.shared)).toBeNull();
    expect(lastPerson(phone)).toBeNull();
  });

  it("signs out again when enrolling fails, so the app is never signed in half way", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const phone = phoneWith(memoryKeychain());

    core.failEnrollments();

    await expect(
      signInWithPassword(core.platform(calls), phone, {
        username: "aiko",
        password: "aiko-password",
      }),
    ).rejects.toMatchObject({ _tag: "Conflict" });
    expect(calls.at(-1)).toBe("signOut");
    expect(core.current()).toBeNull();
    expect(lastPerson(phone)).toBeNull();
  });

  it("leaves the shared keychain alone and signs out when issuing the grant fails", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const phone = phoneWith(memoryKeychain());
    const platform = core.platform(calls);

    const refusing: SignInPlatform = {
      ...platform,
      core: {
        ...platform.core,
        devices: {
          ...platform.core.devices,
          deviceGrants: {
            issue: async () => {
              calls.push("issue");

              throw new Conflict({ message: "too many grants" });
            },
          },
        },
      },
    };

    await expect(
      signInWithPassword(refusing, phone, { username: "aiko", password: "aiko-password" }),
    ).rejects.toMatchObject({ _tag: "Conflict" });
    expect(calls).toEqual(["password", "enroll", "issue", "signOut"]);
    expect(readPhoneAccount(phone.shared)).toBeNull();
    // The device is kept for the next sign-in, and the app asks for the password, never the grant.
    expect(readAppRecord(phone.own, SERVER)).toMatchObject({ device: "dv_1", opened: true });
    expect(await signInOnLaunch(core.platform([]), phone)).toBe("askPassword");
  });
});

describe("signInOnLaunch", () => {
  it("exchanges the phone's grant on an app's first launch and enrolls it as its own device", async () => {
    const core = fakeCore();
    const shared = memoryKeychain();

    await signInWithPassword(core.platform([]), phoneWith(shared), {
      username: "aiko",
      password: "aiko-password",
    });

    const calls: Array<string> = [];
    const music = phoneWith(shared);

    expect(await signInOnLaunch(core.platform(calls), music)).toBe("exchanged");
    expect(calls).toEqual(["exchange", "enroll"]);
    expect(core.enrolled.at(-1)?.device).toBeUndefined();
    expect(lastPerson(music)).toEqual({ userId: "u_aiko", username: "aiko" });
  });

  it("asks for the password once the app had a session, and never exchanges the grant again (D59)", async () => {
    const core = fakeCore();
    const shared = memoryKeychain();
    const movies = phoneWith(shared);

    await signInWithPassword(core.platform([]), movies, {
      username: "aiko",
      password: "aiko-password",
    });

    const calls: Array<string> = [];

    expect(await signInOnLaunch(core.platform(calls), movies)).toBe("askPassword");
    expect(calls).toEqual([]);
  });

  it("asks to sign in when no app on the phone signed in to this server", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];

    expect(await signInOnLaunch(core.platform(calls), phoneWith(memoryKeychain()))).toBe("signIn");
    expect(calls).toEqual([]);
  });

  it("asks to sign in when the core refuses the phone's grant", async () => {
    const core = fakeCore();
    const shared = memoryKeychain();

    await signInWithPassword(core.platform([]), phoneWith(shared), {
      username: "aiko",
      password: "aiko-password",
    });
    core.grants.clear();

    const calls: Array<string> = [];

    expect(await signInOnLaunch(core.platform(calls), phoneWith(shared))).toBe("signIn");
    expect(calls).toEqual(["exchange"]);
  });
});

describe("other sign-ins", () => {
  it("issues a grant for the owner an app sets up", async () => {
    const core = fakeCore();
    const phone = phoneWith(memoryKeychain());

    core.noOwner();
    await setUpOwner(core.platform([]), phone, { username: "lucia", password: "lucia-password" });

    expect(readPhoneAccount(phone.shared)?.userId).toBe("u_lucia");
    expect(lastPerson(phone)?.username).toBe("lucia");
  });

  it("enrolls after an approved device sign-in, which issues no grant", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const phone = phoneWith(memoryKeychain());

    const pending = await startDeviceSignIn(core.platform(calls), phone);

    expect(pending.userCode).toBe("ABCD-EFGH");
    await pending.complete();

    expect(calls).toEqual(["deviceCode:Aiko's iPhone", "enroll"]);
    expect(readPhoneAccount(phone.shared)).toBeNull();
    expect(lastPerson(phone)?.username).toBe("mateo");
  });
});

/**
 * Keychains that save a snapshot of both after every write, so a test can start again from the
 * state a crash right after that write would leave.
 */
const snapshotting = () => {
  const own = new Map<string, string>();
  const shared = new Map<string, string>();

  const snapshots: Array<{
    readonly own: Map<string, string>;
    readonly shared: Map<string, string>;
  }> = [];

  const over = (values: Map<string, string>): Keychain => {
    const write = (key: string, value: string | null): void => {
      if (value === null) values.delete(key);
      else values.set(key, value);
      snapshots.push({ own: new Map(own), shared: new Map(shared) });
    };

    return { read: (key) => values.get(key) ?? null, write, writeDurably: write };
  };

  return { own: over(own), shared: over(shared), snapshots };
};

const restored = (values: Map<string, string>): Keychain => {
  const copy = new Map(values);

  const write = (key: string, value: string | null): void => {
    if (value === null) copy.delete(key);
    else copy.set(key, value);
  };

  return { read: (key) => copy.get(key) ?? null, write, writeDurably: write };
};

/**
 * Starts from each state a crash after a write of a sign-in leaves, with the app's own session
 * gone, as when it is revoked: a launch must never exchange the phone's grant silently (D59).
 */
const expectNoSilentExchange = async (
  core: ReturnType<typeof fakeCore>,
  snapshots: ReadonlyArray<{ own: Map<string, string>; shared: Map<string, string> }>,
) => {
  expect(snapshots.length).toBeGreaterThan(0);

  const launches = await Promise.all(
    snapshots.map(async (snapshot) => {
      const calls: Array<string> = [];
      const phone = phoneWith(restored(snapshot.shared), restored(snapshot.own));

      return { result: await signInOnLaunch(core.platform(calls), phone), calls };
    }),
  );

  for (const launch of launches) {
    expect(launch.result).not.toBe("exchanged");
    expect(launch.calls).not.toContain("exchange");
  }
};

describe("a crash part way through a sign-in", () => {
  it("leaves no state a launch exchanges, at any write of a password sign-in", async () => {
    const core = fakeCore();
    const keychains = snapshotting();

    await signInWithPassword(core.platform([]), phoneWith(keychains.shared, keychains.own), {
      username: "aiko",
      password: "aiko-password",
    });

    await expectNoSilentExchange(core, keychains.snapshots);
  });

  it("leaves no state a launch exchanges, at any write of a second password sign-in on the phone", async () => {
    const core = fakeCore();
    const keychains = snapshotting();

    // The phone's other app signed in first and left Aiko's grant in the shared keychain.
    await signInWithPassword(core.platform([]), phoneWith(keychains.shared), {
      username: "aiko",
      password: "aiko-password",
    });
    keychains.snapshots.length = 0;

    await signInWithPassword(core.platform([]), phoneWith(keychains.shared, keychains.own), {
      username: "mateo",
      password: "mateo-password",
    });

    await expectNoSilentExchange(core, keychains.snapshots);
  });

  it("leaves no state a launch exchanges again, at any write of a first launch's exchange", async () => {
    const core = fakeCore();
    const keychains = snapshotting();

    await signInWithPassword(core.platform([]), phoneWith(keychains.shared), {
      username: "aiko",
      password: "aiko-password",
    });
    keychains.snapshots.length = 0;

    expect(
      await signInOnLaunch(core.platform([]), phoneWith(keychains.shared, keychains.own)),
    ).toBe("exchanged");

    await expectNoSilentExchange(core, keychains.snapshots);
  });
});

const MOVIES_GROUP = "J9DZZ82K23.dev.lmdevv.movies";

const MUSIC_GROUP = "J9DZZ82K23.dev.lmdevv.music";

const SHARED_GROUP = "J9DZZ82K23.dev.lmdevv.media";

const slot = (key: string, options: StoreOptions) => `${options.accessGroup ?? ""}/${key}`;

/**
 * A device keychain whose items outlive the app's process, and which refuses every write to the
 * groups in `refusing`, as iOS does while the device is locked. The set may change as a test runs.
 */
const deviceKeychain = (refusing: ReadonlySet<string>): SecureStoreModule => {
  const items = new Map<string, string>();

  const refuse = (options: StoreOptions): void => {
    if (refusing.has(options.accessGroup ?? "")) throw new Error("errSecInteractionNotAllowed");
  };

  return {
    getItem: (key, options) => items.get(slot(key, options)) ?? null,
    setItem: (key, value, options) => {
      refuse(options);
      items.set(slot(key, options), value);
    },
    getItemAsync: async (key, options) => items.get(slot(key, options)) ?? null,
    setItemAsync: async (key, value, options) => {
      refuse(options);
      items.set(slot(key, options), value);
    },
    deleteItemAsync: async (key, options) => {
      items.delete(slot(key, options));
    },
  };
};

/** The movies app on a phone whose keychain `store` holds, opened afresh as after a process death. */
const moviesOn = (store: SecureStoreModule): Phone => {
  const { own, shared } = openKeychains(store, { own: MOVIES_GROUP, shared: SHARED_GROUP });

  return { own, shared, server: SERVER, deviceName: "Aiko's iPhone" };
};

describe("a keychain that refuses the D59 mark", () => {
  it("asks for the password, and never exchanges, on every launch while the mark cannot be stored", async () => {
    const core = fakeCore();
    const store = deviceKeychain(new Set([MOVIES_GROUP]));
    const music = openKeychains(store, { own: MUSIC_GROUP, shared: SHARED_GROUP });

    // The phone's other app signed Aiko in and left her grant in the shared group.
    await signInWithPassword(
      core.platform([]),
      { own: music.own, shared: music.shared, server: SERVER, deviceName: "Aiko's iPhone" },
      { username: "aiko", password: "aiko-password" },
    );

    const first: Array<string> = [];
    const again: Array<string> = [];

    expect(await signInOnLaunch(core.platform(first), moviesOn(store))).toBe("askPassword");
    // The process dies and the app opens again over the same keychain.
    expect(await signInOnLaunch(core.platform(again), moviesOn(store))).toBe("askPassword");
    expect([...first, ...again]).not.toContain("exchange");
  });

  it("stops a password sign-in before it opens a session when the mark cannot be stored", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];

    await expect(
      signInWithPassword(core.platform(calls), moviesOn(deviceKeychain(new Set([MOVIES_GROUP]))), {
        username: "aiko",
        password: "aiko-password",
      }),
    ).rejects.toMatchObject({ _tag: "KeychainWriteFailed" });
    expect(calls).toEqual([]);
    expect(core.current()).toBeNull();
  });

  it("signs a session out again when the grant cannot be stored, and keeps no grant", async () => {
    const core = fakeCore();
    const calls: Array<string> = [];
    const refusing = new Set<string>();
    const store = deviceKeychain(refusing);
    const phone = moviesOn(store);

    // The device locks after the app opened its keychains, so only writing the grant fails.
    refusing.add(SHARED_GROUP);

    await expect(
      signInWithPassword(core.platform(calls), phone, {
        username: "aiko",
        password: "aiko-password",
      }),
    ).rejects.toMatchObject({ _tag: "KeychainWriteFailed" });
    expect(calls.at(-1)).toBe("signOut");
    expect(readPhoneAccount(moviesOn(store).shared)).toBeNull();
    expect(await signInOnLaunch(core.platform([]), moviesOn(store))).toBe("askPassword");
  });
});
