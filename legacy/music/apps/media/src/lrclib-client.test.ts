/**
 * The LRCLIB client against a stand-in over real HTTP: which failures are LRCLIB's and which are
 * one record's, and that a slow or oversized answer never holds the client past its bounds.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect } from "effect";

import * as LrclibClient from "./lrclib-client.ts";
import type { LookupQuery } from "./media-backend.ts";
import { type FakeLrclibHandler, fakeLrclib, json } from "./testing/fake-lrclib.ts";
import { MEDIA_TEST_TIMEOUT } from "./testing/fixtures.ts";
import { runScoped } from "./testing/run.ts";

const QUERY: LookupQuery = {
  artist: "Massive Attack",
  title: "Unfinished Sympathy",
  album: "Blue Lines",
  durationS: 308,
};

const client = (handler: FakeLrclibHandler, options: Partial<LrclibClient.Options> = {}) =>
  Effect.gen(function* () {
    const lrclib = yield* fakeLrclib(handler);

    const made = yield* LrclibClient.make({
      baseUrl: lrclib.url,
      userAgent: LrclibClient.USER_AGENT,
      gap: Duration.millis(10),
      timeout: Duration.seconds(2),
      failurePause: Duration.millis(100),
      maxFailurePause: Duration.seconds(1),
      maxBodyBytes: 64 * 1024,
      ...options,
    });

    return { lrclib, client: made };
  });

/** How long `effect` took, with its result or failure. */
const timed = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const result = yield* Effect.result(effect);

    return { result, ms: (yield* Clock.currentTimeMillis) - start };
  });

describe("LrclibClient", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("pauses for Retry-After as soon as a 429 arrives, without waiting for its body", () =>
    runScoped(
      Effect.gen(function* () {
        const { client: lrclib } = yield* client(
          () => ({ ...json(429, { message: "slow down" }, { "retry-after": "60" }), stall: true }),
          { maxFailurePause: Duration.minutes(5) },
        );

        const { result, ms } = yield* timed(lrclib.lookup(QUERY));

        expect(ms).toBeLessThan(1000);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LrclibUnavailable", reason: "rate_limited", pauseMs: 60_000 },
        });
      }),
    ));

  it("pauses no longer than its longest pause, whatever Retry-After asks", () =>
    runScoped(
      Effect.gen(function* () {
        const yearAhead = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();

        for (const retryAfter of ["86400", yearAhead]) {
          const { client: lrclib } = yield* client(() =>
            json(429, { message: "slow down" }, { "retry-after": retryAfter }),
          );

          expect(yield* Effect.result(lrclib.lookup(QUERY))).toMatchObject({
            failure: { _tag: "LrclibUnavailable", reason: "rate_limited", pauseMs: 1000 },
          });
        }
      }),
    ));

  it("hangs up on an answer slower than the timeout", () =>
    runScoped(
      Effect.gen(function* () {
        const { client: lrclib, lrclib: fake } = yield* client(
          () => ({ status: 200, body: '{"id": 1, ', stall: true }),
          { timeout: Duration.millis(300) },
        );

        const { result } = yield* timed(lrclib.lookup(QUERY));

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LrclibUnavailable", reason: "timeout" },
        });

        yield* Effect.sleep("200 millis");
        expect(fake.hungUp()).toBe(1);
      }),
    ));

  it("counts an answer larger than the bound as an unreadable record", () =>
    runScoped(
      Effect.gen(function* () {
        const { client: lrclib } = yield* client(
          () => json(200, { id: 1, plainLyrics: "la ".repeat(10_000) }),
          { maxBodyBytes: 1024 },
        );

        const { result } = yield* timed(lrclib.lookup(QUERY));

        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LrclibMalformed" } });
      }),
    ));

  it("treats any 4xx but 404 as LRCLIB unavailable, backing off further each time", () =>
    runScoped(
      Effect.gen(function* () {
        const { client: lrclib, lrclib: fake } = yield* client(() => json(400, { error: "bad" }));
        const first = yield* timed(lrclib.lookup(QUERY));
        const second = yield* timed(lrclib.lookup(QUERY));

        expect(first.result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LrclibUnavailable", reason: "rejected", status: 400, pauseMs: 100 },
        });
        expect(second.result).toMatchObject({
          failure: { _tag: "LrclibUnavailable", pauseMs: 200 },
        });

        const [one, two] = fake.requests();

        expect((two?.at ?? 0) - (one?.at ?? 0)).toBeGreaterThanOrEqual(95);
      }),
    ));
});
