import { Context, Effect, Exit, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import type { SharedStore } from "./shared-store";
import { makeBrowserTabs } from "./testing/browser-tabs";
import type { BrowserTabs } from "./testing/browser-tabs";
import { jwtExpiringAt } from "./testing/fake-convex";
import type { KeyValueStore } from "./token-storage";
import { layerKeyValue, layerShared, TokenStorage } from "./token-storage";

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

const sharedOver = (store: SharedStore, slot = "s") =>
  Effect.scoped(Layer.build(layerShared(store, slot))).pipe(
    Effect.map((context) => Context.get(context, TokenStorage)),
  );

const tabsOf = (count: number) =>
  Effect.promise(() => makeBrowserTabs({ count, delivery: "at once" }));

const keysOf = (tabs: BrowserTabs) => Effect.promise(async () => [...(await tabs.items()).keys()]);

describe("token storage shared between tabs in IndexedDB", () => {
  it("renews a session only while it still holds the tokens the renewal started from", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(1);
        const storage = yield* sharedOver(tabs.tab(0));

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

  it("refuses a renewal of a revoked session, and loads none", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* sharedOver(tabs.tab(0));
        const renewing = yield* sharedOver(tabs.tab(1));

        yield* signingOut.save(ada);
        yield* signingOut.revoke(ada);

        return {
          late: yield* renewing.renew(ada, adaRenewed),
          loaded: yield* renewing.load,
          revocation: yield* renewing.revocation(adaRenewed),
        };
      }),
    );

    expect(answer).toStrictEqual({ late: false, loaded: Option.none(), revocation: "pending" });
  });

  it("revokes all or nothing: a full store keeps no partial records, and the tokens go", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* sharedOver(tabs.tab(0));
        const other = yield* sharedOver(tabs.tab(1));

        yield* signingOut.save(ada);
        tabs.fill(true);
        const revoked = yield* Effect.exit(signingOut.revoke(ada));

        tabs.fill(false);

        return {
          revoked: Exit.isFailure(revoked),
          keys: (yield* keysOf(tabs)).toSorted(),
          revocation: yield* other.revocation(ada),
          late: yield* other.renew(ada, adaRenewed),
        };
      }),
    );

    expect(answer).toStrictEqual({
      revoked: true,
      keys: ["s"],
      revocation: "missing",
      late: false,
    });
  });

  it("keeps both revocations when two tabs sign out different sessions", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(3);
        const first = yield* sharedOver(tabs.tab(0));
        const second = yield* sharedOver(tabs.tab(1));
        const reader = yield* sharedOver(tabs.tab(2));

        yield* first.save(ada);
        yield* second.save(bo);
        yield* Effect.all([first.revoke(ada), second.revoke(bo)], { concurrency: "unbounded" });

        return {
          ada: yield* reader.revocation(ada),
          bo: yield* reader.revocation(bo),
          loaded: yield* reader.load,
        };
      }),
    );

    expect(answer).toStrictEqual({ ada: "pending", bo: "pending", loaded: Option.none() });
  });

  it("loads a sign-in made after a revocation, and forgets the pending sign-out once confirmed", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(1);
        const storage = yield* sharedOver(tabs.tab(0));

        yield* storage.save(ada);
        yield* storage.revoke(ada);

        const pending = (yield* storage.pendingSignOuts).map((held) =>
          Redacted.value(held.refreshToken),
        );

        yield* storage.confirmRevoked(ada);
        yield* storage.save(bo);

        return {
          pending,
          after: yield* storage.pendingSignOuts,
          loaded: refreshTokenOf(yield* storage.load),
          ada: yield* storage.revocation(ada),
        };
      }),
    );

    expect(answer).toStrictEqual({
      pending: ["refresh-1"],
      after: [],
      loaded: Option.some("refresh-3"),
      ada: "confirmed",
    });
  });

  it("finds a pending sign-out from any slot, and never loads it", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(1);
        const slot = yield* sharedOver(tabs.tab(0), "slot-1");
        const elsewhere = yield* sharedOver(tabs.tab(0), "slot-2");

        yield* slot.save(ada);
        yield* slot.revoke(ada);

        return {
          pending: (yield* elsewhere.pendingSignOuts).length,
          loaded: yield* elsewhere.load,
          loadedHere: yield* slot.load,
        };
      }),
    );

    expect(answer).toStrictEqual({ pending: 1, loaded: Option.none(), loadedHere: Option.none() });
  });

  it("sweeps revocations only once their sessions can no longer work, and never a live session", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const cleo = signedInAs("cleo|session-3", "refresh-4");

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const testClock = yield* Layer.build(TestClock.layer());

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const tabs = yield* tabsOf(1);
          const storage = yield* sharedOver(tabs.tab(0));

          yield* storage.save(ada);
          yield* storage.revoke(ada);
          yield* storage.confirmRevoked(ada);
          yield* storage.save(cleo);
          yield* storage.revoke(cleo);
          yield* storage.save(bo);
          yield* TestClock.adjust(30 * DAY);
          yield* storage.sweep;
          const before = (yield* keysOf(tabs)).toSorted();

          yield* TestClock.adjust(2 * DAY);
          yield* storage.sweep;

          return {
            before,
            after: (yield* keysOf(tabs)).toSorted(),
            loaded: refreshTokenOf(yield* storage.load),
          };
        }).pipe(Effect.provideContext(testClock));
      }).pipe(Effect.scoped),
    );

    expect(answer).toStrictEqual({
      before: [
        "media.revoked:ada|session-1",
        "media.revoked:cleo|session-3",
        "media.signOut:cleo|session-3",
        "s",
        "s:bo|session-2",
      ],
      after: ["s", "s:bo|session-2"],
      loaded: Option.some("refresh-3"),
    });
  });
});
