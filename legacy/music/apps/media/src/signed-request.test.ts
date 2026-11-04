import { signResource } from "@music/commands/signed-url";
import { describe, expect, it } from "vitest";
import { Clock, Effect, Redacted } from "effect";

import { isSignedRequestValid } from "./signed-request.ts";
import { runScoped } from "./testing/run.ts";

const KEY = "test-signing-key";

const resource = { kind: "stream", trackId: "track1", profile: "original" } as const;

const signed = (expiresAt: number) =>
  Effect.promise(() => signResource(KEY, resource, expiresAt)).pipe(
    Effect.map((sig) => ({ exp: String(expiresAt), sig })),
  );

describe("isSignedRequestValid", () => {
  it("accepts a valid signature before it expires", () =>
    runScoped(
      Effect.gen(function* () {
        const NOW = yield* Clock.currentTimeMillis;
        const query = yield* signed(NOW + 60_000);

        expect(yield* isSignedRequestValid(Redacted.make(KEY), resource, query)).toBe(true);
      }),
    ));

  it("rejects an expired signature", () =>
    runScoped(
      Effect.gen(function* () {
        const NOW = yield* Clock.currentTimeMillis;
        const query = yield* signed(NOW - 1);

        expect(yield* isSignedRequestValid(Redacted.make(KEY), resource, query)).toBe(false);
      }),
    ));

  it("rejects tampered signatures, resources, expiries, and keys", () =>
    runScoped(
      Effect.gen(function* () {
        const NOW = yield* Clock.currentTimeMillis;
        const query = yield* signed(NOW + 60_000);
        const key = Redacted.make(KEY);
        const flipped = `${query.sig.slice(0, -1)}${query.sig.endsWith("A") ? "B" : "A"}`;

        expect(yield* isSignedRequestValid(key, resource, { ...query, sig: flipped })).toBe(false);
        expect(yield* isSignedRequestValid(key, { ...resource, trackId: "track2" }, query)).toBe(
          false,
        );
        expect(yield* isSignedRequestValid(key, { ...resource, profile: "aac-320" }, query)).toBe(
          false,
        );
        expect(yield* isSignedRequestValid(key, { kind: "art", hash: "track1" }, query)).toBe(
          false,
        );
        expect(
          yield* isSignedRequestValid(key, resource, { ...query, exp: String(NOW + 120_000) }),
        ).toBe(false);
        expect(yield* isSignedRequestValid(Redacted.make("other-key"), resource, query)).toBe(
          false,
        );
      }),
    ));

  it("rejects missing and malformed parameters", () =>
    runScoped(
      Effect.gen(function* () {
        const NOW = yield* Clock.currentTimeMillis;
        const query = yield* signed(NOW + 60_000);
        const key = Redacted.make(KEY);

        expect(yield* isSignedRequestValid(key, resource, { exp: undefined, sig: query.sig })).toBe(
          false,
        );
        expect(yield* isSignedRequestValid(key, resource, { exp: query.exp, sig: undefined })).toBe(
          false,
        );
        expect(yield* isSignedRequestValid(key, resource, { exp: "1e15", sig: query.sig })).toBe(
          false,
        );
        expect(yield* isSignedRequestValid(key, resource, { exp: query.exp, sig: "" })).toBe(false);
      }),
    ));
});
