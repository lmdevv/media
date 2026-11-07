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
