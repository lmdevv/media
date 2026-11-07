import { TokenStorage as Storage } from "@media/sdk/effect";
import { openIndexedDb } from "@media/sdk/promise";
import type { SharedStore } from "@media/sdk/promise";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { Context, Effect, Exit, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { makeBrowserTabs } from "./testing/browser-tabs";
import { DAY, onClockSkewedBy } from "./testing/clock";
import type { BrowserTabs } from "./testing/browser-tabs";

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
  Effect.scoped(Layer.build(Storage.layerShared(store, slot))).pipe(
    Effect.map((context) => Context.get(context, Storage.TokenStorage)),
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

  it("keeps every revocation however long ago, and still loads the live session", async () => {
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
          const before = (yield* keysOf(tabs)).toSorted();

          yield* TestClock.adjust(400 * DAY);

          return {
            before,
            after: (yield* keysOf(tabs)).toSorted(),
            again: yield* storage.save(ada),
            loaded: refreshTokenOf(yield* storage.load),
          };
        }).pipe(Effect.provideContext(testClock));
      }).pipe(Effect.scoped),
    );

    const kept = [
      "media.revoked:ada|session-1",
      "media.revoked:cleo|session-3",
      "media.signOut:cleo|session-3",
      "s",
      "s:bo|session-2",
    ];

    expect(answer).toStrictEqual({
      before: kept,
      after: kept,
      again: false,
      loaded: Option.some("refresh-3"),
    });
  });

  it("never stores a session again once it was signed out here", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* sharedOver(tabs.tab(0));
        const late = yield* sharedOver(tabs.tab(1));

        yield* signingOut.save(ada);
        yield* signingOut.revoke(ada);

        return {
          stored: yield* late.save(ada),
          loaded: yield* late.load,
          tokens: (yield* keysOf(tabs)).includes("s:ada|session-1"),
        };
      }),
    );

    expect(answer).toStrictEqual({ stored: false, loaded: Option.none(), tokens: false });
  });
  it("keeps a signed-out session out and a slot's live session in, whatever each tab's clock says", async () => {
    const old = signedInAs("ada|session-old", "refresh-old");
    const live = signedInAs("ada|session-live", "refresh-live");

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const late = yield* sharedOver(tabs.tab(0));
        const signingIn = yield* sharedOver(tabs.tab(1));
        // The late tab's clock runs 60 days behind, the other's 60 days ahead.
        const behind = onClockSkewedBy(-60 * DAY);
        const ahead = onClockSkewedBy(60 * DAY);

        // The late tab asks; meanwhile it signs the old session out and the core confirms.
        yield* behind(late.save(old));
        yield* behind(late.revoke(old));
        yield* behind(late.confirmRevoked(old));
        yield* ahead(signingIn.save(live));

        return {
          stored: yield* behind(late.save(old)),
          loaded: refreshTokenOf(yield* signingIn.load),
          revoked: (yield* keysOf(tabs)).includes("media.revoked:ada|session-old"),
        };
      }),
    );

    expect(answer).toStrictEqual({
      stored: false,
      loaded: Option.some("refresh-live"),
      revoked: true,
    });
  });

  it("never lets a sign-in answer replace another session its slot holds", async () => {
    const live = signedInAs("ada|session-live", "refresh-live");
    const other = signedInAs("ada|session-other", "refresh-other");

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const late = yield* sharedOver(tabs.tab(0));
        const signingIn = yield* sharedOver(tabs.tab(1));

        yield* signingIn.save(live);

        return {
          stored: yield* late.save(other),
          again: yield* signingIn.save(live),
          loaded: refreshTokenOf(yield* signingIn.load),
        };
      }),
    );

    expect(answer).toStrictEqual({
      stored: false,
      again: true,
      loaded: Option.some("refresh-live"),
    });
  });

  it("never stores a session signed out here again, however many sign-outs were confirmed since", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const late = yield* sharedOver(tabs.tab(0));
        const signingOut = yield* sharedOver(tabs.tab(1), "other");

        // The late tab's sign-in request starts; its answer for Ada's session arrives last.

        yield* signingOut.save(ada);
        yield* signingOut.revoke(ada);
        yield* signingOut.confirmRevoked(ada);

        yield* Effect.forEach(
          Array.from({ length: 65 }, (_, index) =>
            signedInAs(`cleo|session-${index + 10}`, `refresh-${index + 10}`),
          ),
          (each) =>
            Effect.gen(function* () {
              yield* signingOut.save(each);
              yield* signingOut.revoke(each);
              yield* signingOut.confirmRevoked(each);
            }),
          { discard: true },
        );

        return {
          stored: yield* late.save(ada),
          loaded: yield* late.load,
          revocation: yield* late.revocation(ada),
        };
      }),
    );

    expect(answer).toStrictEqual({ stored: false, loaded: Option.none(), revocation: "confirmed" });
  });
});

describe("opening IndexedDB", () => {
  it("gives up after five seconds when the open never finishes, as when another tab blocks it", async () => {
    vi.useFakeTimers();

    try {
      const opening = openIndexedDb({
        indexedDB: {
          open: () => ({
            get result(): never {
              throw new Error("A stalled open has no database");
            },
            error: undefined,
            addEventListener: () => undefined,
          }),
        },
        name: "media",
        channel: () => ({ post: () => undefined, close: () => undefined }),
      });

      const settled = expect(opening).rejects.toThrow("did not open in time");

      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
