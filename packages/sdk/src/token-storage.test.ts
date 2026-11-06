import { Context, Effect, Layer, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeBrowserTabs } from "./testing/browser-tabs";
import { jwtExpiringAt } from "./testing/fake-convex";
import type { KeyValueStore } from "./token-storage";
import { layerKeyValue, TokenStorage } from "./token-storage";

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

const session = { token: Redacted.make("jwt"), refreshToken: Redacted.make("refresh") };

const storageOver = (store: KeyValueStore) =>
  Effect.scoped(Layer.build(layerKeyValue(store, "s"))).pipe(
    Effect.map((context) => Context.get(context, TokenStorage)),
  );

describe("key-value token storage", () => {
  it("round-trips a session and clears it on sign-out", async () => {
    const store = memoryStore();

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* storageOver(store);

        yield* storage.save(session);
        expect(store.items.get("s")).toContain("refresh");

        const loaded = yield* storage.load;

        expect(Option.map(loaded, (s) => Redacted.value(s.refreshToken))).toStrictEqual(
          Option.some("refresh"),
        );

        yield* storage.revoke(session);
        expect(yield* storage.load).toStrictEqual(Option.none());
      }),
    );
  });

  it("reads unreadable stored text as signed out", async () => {
    const store = memoryStore();

    store.items.set("s", "{not json");

    const loaded = await Effect.runPromise(Effect.flatMap(storageOver(store), (s) => s.load));

    expect(loaded).toStrictEqual(Option.none());
  });

  it("reports a failing store as a typed error", async () => {
    const broken: KeyValueStore = {
      getItem: () => Promise.reject(new Error("quota")),
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    const failure = await Effect.runPromise(
      Effect.flip(Effect.flatMap(storageOver(broken), (s) => s.load)),
    );

    expect(failure).toMatchObject({ _tag: "TokenStorageError", operation: "load" });
  });
});

const signedInAs = (subject: string, refreshToken: string) => ({
  token: Redacted.make(jwtExpiringAt(Date.now() + 3_600_000, subject)),
  refreshToken: Redacted.make(refreshToken),
});

const ada = signedInAs("ada|session-1", "refresh-1");

const adaRenewed = signedInAs("ada|session-1", "refresh-2");

const bo = signedInAs("bo|session-2", "refresh-3");

const refreshTokenOf = (loaded: Option.Option<{ readonly refreshToken: Redacted.Redacted }>) =>
  Option.map(loaded, (held) => Redacted.value(held.refreshToken));

describe("token storage shared between tabs", () => {
  it("renews a session only while it still holds the tokens the renewal started from", async () => {
    const tabs = makeBrowserTabs({ count: 1, processes: "shared", delivery: "at once" });

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* storageOver(tabs.tab(0));

        yield* storage.save(ada);
        const stale = yield* storage.renew(adaRenewed, ada);
        const renewing = yield* storage.renew(ada, adaRenewed);

        return { stale, renewing, loaded: refreshTokenOf(yield* storage.load) };
      }),
    );

    expect(answer).toStrictEqual({
      stale: false,
      renewing: true,
      loaded: Option.some("refresh-2"),
    });
  });

  it("keeps a revoked session out, whatever writes of its tokens land later", async () => {
    const tabs = makeBrowserTabs({ count: 2, processes: "separate", delivery: "manual" });

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const signingOut = yield* storageOver(tabs.tab(0));
        const renewing = yield* storageOver(tabs.tab(1));

        yield* signingOut.save(ada);
        tabs.deliver();
        yield* signingOut.revoke(ada);
        const late = yield* renewing.renew(ada, adaRenewed);

        tabs.deliver();

        return {
          late,
          loaded: yield* renewing.load,
          revocation: yield* renewing.revocation(adaRenewed),
        };
      }),
    );

    expect(answer).toStrictEqual({ late: true, loaded: Option.none(), revocation: "pending" });
  });

  it("keeps both revocations when two tabs sign out different sessions at once", async () => {
    const tabs = makeBrowserTabs({ count: 3, processes: "separate", delivery: "manual" });

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* storageOver(tabs.tab(0));
        const second = yield* storageOver(tabs.tab(1));
        const reader = yield* storageOver(tabs.tab(2));

        yield* first.save(ada);
        tabs.deliver();
        yield* second.save(bo);
        yield* first.revoke(ada);
        yield* second.revoke(bo);
        tabs.deliver();

        return {
          ada: yield* reader.revocation(ada),
          bo: yield* reader.revocation(bo),
          loaded: yield* reader.load,
        };
      }),
    );

    expect(answer).toStrictEqual({ ada: "pending", bo: "pending", loaded: Option.none() });
  });

  it("loads a sign-in made after a revocation, and drops tokens once the server confirms", async () => {
    const tabs = makeBrowserTabs({ count: 1, processes: "shared", delivery: "at once" });

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* storageOver(tabs.tab(0));

        yield* storage.save(ada);
        yield* storage.revoke(ada);
        yield* storage.confirmRevoked(ada);
        yield* storage.save(bo);

        return {
          loaded: refreshTokenOf(yield* storage.load),
          ada: yield* storage.revocation(ada),
          adaTokens: [...tabs.items.values()].some((value) => value.includes("refresh-1")),
        };
      }),
    );

    expect(answer).toStrictEqual({
      loaded: Option.some("refresh-3"),
      ada: "confirmed",
      adaTokens: false,
    });
  });

  it("keeps a pending sign-out outside every session key until the server confirms it", async () => {
    const tabs = makeBrowserTabs({ count: 1, processes: "shared", delivery: "at once" });

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const slot = yield* Effect.scoped(Layer.build(layerKeyValue(tabs.tab(0), "slot-1"))).pipe(
          Effect.map((context) => Context.get(context, TokenStorage)),
        );

        const elsewhere = yield* Effect.scoped(
          Layer.build(layerKeyValue(tabs.tab(0), "slot-2")),
        ).pipe(Effect.map((context) => Context.get(context, TokenStorage)));

        yield* slot.save(ada);
        yield* slot.revoke(ada);

        for (const key of Array.from(tabs.items.keys())) {
          if (key.startsWith("slot-1") && !key.endsWith(":revoked")) {
            yield* Effect.promise(async () => tabs.tab(0).removeItem(key));
          }
        }

        const pending = (yield* elsewhere.pendingSignOuts).map((held) =>
          Redacted.value(held.refreshToken),
        );

        const loadedElsewhere = yield* elsewhere.load;

        yield* elsewhere.confirmRevoked(ada);

        return {
          pending,
          loadedElsewhere,
          after: yield* elsewhere.pendingSignOuts,
          confirmed: tabs.items.has("slot-1:ada|session-1:confirmed"),
        };
      }),
    );

    expect(answer).toStrictEqual({
      pending: ["refresh-1"],
      loadedElsewhere: Option.none(),
      after: [],
      confirmed: true,
    });
  });
});
