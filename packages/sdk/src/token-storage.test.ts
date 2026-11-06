import { Context, Effect, Layer, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

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
  it("round-trips a session and clears it", async () => {
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

        yield* storage.clear;
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

  it("replaces the session only while the store still holds the expected one", async () => {
    const store = memoryStore();
    const renewed = { token: Redacted.make("jwt-2"), refreshToken: Redacted.make("refresh-2") };

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* storageOver(store);

        yield* storage.save(session);
        const stale = yield* storage.replace(Option.some(renewed), Option.none());
        const renewing = yield* storage.replace(Option.some(session), Option.some(renewed));
        const afterRenewal = store.items.get("s");
        const clearing = yield* storage.replace(Option.some(renewed), Option.none());

        return { stale, renewing, afterRenewal, clearing, afterClear: store.items.get("s") };
      }),
    );

    expect(answer).toStrictEqual({
      stale: false,
      renewing: true,
      afterRenewal: '{"token":"jwt-2","refreshToken":"refresh-2"}',
      clearing: true,
      afterClear: undefined,
    });
  });

  it("checks the stored session inside the store's exclusive section", async () => {
    const store = memoryStore();

    const signedOutWhileWaiting: KeyValueStore = {
      ...store,
      exclusive: async (_key, write) => {
        store.items.delete("s");

        return write();
      },
    };

    store.items.set("s", '{"token":"jwt","refreshToken":"refresh"}');

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* storageOver(signedOutWhileWaiting);
        const renewed = { token: Redacted.make("jwt-2"), refreshToken: Redacted.make("refresh-2") };

        return yield* storage.replace(Option.some(session), Option.some(renewed));
      }),
    );

    expect({ wrote: answer, stored: store.items.get("s") }).toStrictEqual({
      wrote: false,
      stored: undefined,
    });
  });
});
