import { DeviceId, RoomId } from "@media/contracts/ids";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { MoviesSdk } from "./promise";
import { createMovies } from "./promise";
import { DEFAULT_TUNABLES } from "./room-sync/sync-policy";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import { makeFakePlayer } from "./testing/fake-player";
import type { KeyValueStore } from "./token-storage";

const KEY = "movies.session";

const memoryStore = (): KeyValueStore & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();

  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
};

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const withSdk = (
  store: KeyValueStore,
  body: (fake: FakeConvex.FakeConvex, sdk: MoviesSdk) => Promise<void>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;
        const sdk = createMovies({ convexUrl: fake.url, connection: "http", storage: store });

        yield* Effect.promise(async () => {
          try {
            await body(fake, sdk);
          } finally {
            await sdk.dispose();
          }
        });
      }),
    ),
  );

const control = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

const SAM = jwtExpiringAt(Date.now() + 3_600_000, "sam");

const signedIn = (): KeyValueStore & { readonly items: Map<string, string> } => {
  const store = memoryStore();

  store.items.set(KEY, JSON.stringify({ token: SAM, refreshToken: "refresh-1" }));

  return store;
};

const START = Date.now();

const ROOM = {
  id: "room-1",
  title: {
    id: "title-1",
    kind: "movie",
    name: "Fixture",
    year: 2024,
    certification: null,
    ageRating: null,
    runtimeMs: 7_200_000,
    genres: [],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: START,
  },
  episode: null,
  fileId: "file-1",
  hostUserId: "user-1",
  hostProfileId: "profile-1",
  hostDeviceId: "host-device",
  hostProfileName: "Alex",
  hostAway: false,
  next: null,
  clock: {
    status: "paused",
    positionAtAnchorMs: 0,
    anchorServerTime: START,
    playbackRate: 1,
    revision: 0,
  },
  members: [],
  createdAt: START,
};

describe("createMovies", () => {
  it("signs in with a password and stores the session", () => {
    const store = memoryStore();

    return withSdk(store, async (fake, sdk) => {
      await control(
        fake.reply(
          "auth:signIn",
          Reply.Success({ value: { tokens: { token: SAM, refreshToken: "refresh-1" } } }),
        ),
      );

      await sdk.auth.signInWithPassword({
        flow: "signIn",
        email: "sam@example.com",
        password: "pw",
      });

      expect(await sdk.auth.status()).toBe("signedIn");
      expect(store.items.get(KEY)).toBe(JSON.stringify({ token: SAM, refreshToken: "refresh-1" }));
      expect((await control(fake.requestsTo("auth:signIn"))).map((r) => r.args)).toStrictEqual([
        {
          provider: "password",
          params: { flow: "signIn", email: "sam@example.com", password: "pw" },
        },
      ]);
    });
  });

  it("resolves a query with its decoded result", () =>
    withSdk(signedIn(), async (fake, sdk) => {
      await control(
        fake.reply("deviceAuth:status", Reply.Success({ value: { state: "approved" } })),
      );

      expect(await sdk.query("deviceAuth.status", { deviceCode: "device-secret" })).toStrictEqual({
        state: "approved",
      });
      expect(
        (await control(fake.requestsTo("deviceAuth:status"))).map((r) => r.authorization),
      ).toStrictEqual([`Bearer ${SAM}`]);
    }));

  it("rejects with the tagged error a command failure names", () =>
    withSdk(signedIn(), async (fake, sdk) => {
      await control(
        fake.reply("deviceAuth:status", Reply.Failure({ code: "not_found", message: "Gone" })),
      );

      await expect(
        sdk.query("deviceAuth.status", { deviceCode: "device-secret" }),
      ).rejects.toMatchObject({ _tag: "NotFound", message: "Gone" });
    }));

  it("sends a call whose token is rejected once, and rejects with Unauthenticated", () =>
    withSdk(signedIn(), async (fake, sdk) => {
      await control(fake.reply("deviceAuth:status", Reply.TokenRejected()));

      const refused = await sdk.query("deviceAuth.status", { deviceCode: "device-secret" }).then(
        () => null,
        (error: Error) => error,
      );

      expect(refused).toMatchObject({ _tag: "Unauthenticated" });
      expect(
        (await control(fake.requestsTo("deviceAuth:status"))).map((r) => r.authorization),
      ).toStrictEqual([`Bearer ${SAM}`]);
    }));

  it("delivers a subscription's value and stops it", () =>
    withSdk(signedIn(), async (fake, sdk) => {
      await control(
        fake.reply("deviceAuth:status", Reply.Success({ value: { state: "pending" } })),
      );

      const values: Array<unknown> = [];

      const stop = await new Promise<() => Promise<void>>((resolve, reject) => {
        const stopping = sdk.subscribe(
          "deviceAuth.status",
          { deviceCode: "device-secret" },
          (value) => {
            values.push(value);
            resolve(stopping);
          },
          reject,
        );
      });

      await stop();

      expect(values).toStrictEqual([{ state: "pending" }]);
    }));

  it("stops a running room sync on dispose, and stopping it afterwards still resolves", () =>
    withSdk(signedIn(), async (fake, sdk) => {
      await control(fake.reply("rooms:get", Reply.Success({ value: ROOM })));
      await control(
        fake.handle("rooms:time", () =>
          Effect.sync(() => Reply.Success({ value: { serverTime: Date.now() } })),
        ),
      );
      await control(fake.reply("rooms:heartbeat", Reply.Success({ value: ROOM.clock })));

      const heartbeats = async (): Promise<number> =>
        (await control(fake.requestsTo("rooms:heartbeat"))).length;

      const player = await Effect.runPromise(makeFakePlayer(0));

      const sync = await sdk.rooms.sync(
        RoomId.make("room-1"),
        DeviceId.make("guest-device"),
        player,
        { ...DEFAULT_TUNABLES, offsetSamples: 1, heartbeatIntervalMs: 20 },
      );

      await settle(150);
      expect(await heartbeats()).toBeGreaterThan(0);

      await sdk.dispose();
      await settle(50);
      const afterDispose = await heartbeats();

      await settle(300);
      expect(await heartbeats()).toBe(afterDispose);
      await expect(sync.stop()).resolves.toBeUndefined();
    }));
});
