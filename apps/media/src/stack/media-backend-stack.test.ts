import { assert, describe, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Redacted, Schedule, Stream } from "effect";

import { TransportError } from "@media/sdk/effect";

import * as MediaBackend from "../convex/media-backend.ts";
import { findMediaStack } from "../testing/stack-processes.ts";
import { startTcpProxy } from "../testing/tcp-proxy.ts";

const stack = findMediaStack();

const proxy = stack === undefined ? undefined : await startTcpProxy(new URL(stack.convexUrl));

proxy?.setMode("refuse");

/**
 * After the first test's outage of about 17 seconds, the Convex client's WebSocket waits up to
 * 16 seconds plus half again between reconnects, and the service's own sign-in retries reach 16
 * seconds plus a fifth. Either can take about 24 seconds once Convex is back.
 */
const RECONNECTS_WITHIN = Duration.seconds(40);

const backendLayer = Layer.unwrap(
  Effect.sync(() =>
    MediaBackend.layer({
      convexUrl: `http://127.0.0.1:${String(proxy?.port ?? 0)}`,
      apiKey: Redacted.make(stack?.mediaServiceKey ?? ""),
      callTimeout: Duration.seconds(3),
    }),
  ),
).pipe(Layer.orDie);

const awaitStatus = (status: "connected" | "connecting", within: Duration.Input) =>
  Effect.gen(function* () {
    const backend = yield* MediaBackend.Service;

    yield* backend.status.pipe(
      Effect.repeat({
        until: (current) => current === status,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeout(within),
    );
  });

describe.skipIf(stack === undefined)("media service Convex connection", () => {
  layer(backendLayer, { excludeTestServices: true, timeout: "300 seconds" })((it) => {
    it.effect(
      "keeps retrying while Convex is down, then signs in once it is back",
      () =>
        Effect.gen(function* () {
          const backend = yield* MediaBackend.Service;

          yield* Effect.sleep(Duration.seconds(2));
          assert.strictEqual(yield* backend.status, "connecting");

          const early = yield* backend.call("mediaService.pendingJobs", {}).pipe(Effect.flip);

          assert.instanceOf(early, TransportError);

          proxy?.setMode("open");
          yield* awaitStatus("connected", RECONNECTS_WITHIN);

          // The WebSocket keeps its own reconnect backoff from the outage; calls wait for it, each
          // within its timeout, and callers retry as the job worker and watchers do.
          assert.isArray(
            yield* backend
              .call("mediaService.pendingJobs", {})
              .pipe(Effect.retry({ times: 15, schedule: Schedule.spaced("2 seconds") })),
          );
        }),
      90_000,
    );

    it.effect(
      "carries on after its connections are cut, subscriptions included",
      () =>
        Effect.gen(function* () {
          const backend = yield* MediaBackend.Service;
          const first = yield* Deferred.make<void>();

          const updates = yield* backend.subscribe("mediaService.libraries", {}).pipe(
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* Deferred.await(first).pipe(Effect.timeout(RECONNECTS_WITHIN));
          proxy?.drop();

          // The WebSocket reconnects on its own; the call waits for it, within its timeout.
          const after = yield* backend
            .call("mediaService.pendingJobs", {})
            .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("1 second") }));

          assert.isArray(after);

          const delivered = yield* Fiber.join(updates).pipe(Effect.timeout(Duration.seconds(45)));

          assert.strictEqual(delivered.length, 2);
        }),
      90_000,
    );

    it.effect(
      "gives up on a call that gets no answer, and works again afterwards",
      () =>
        Effect.gen(function* () {
          const backend = yield* MediaBackend.Service;

          // A query with arguments no one asked before must reach the server: none is cached.
          const fresh = () =>
            backend.call("mediaService.trickplayVersions", {
              fileIds: [`unknown-${crypto.randomUUID()}`],
            });

          proxy?.setMode("blackhole");
          proxy?.drop();
          yield* Effect.sleep(Duration.seconds(1));

          const started = Date.now();
          const error = yield* fresh().pipe(Effect.flip);

          assert.instanceOf(error, TransportError);
          assert.include(error.message, "did not answer within 3 seconds");
          assert.isBelow(Date.now() - started, 10_000);

          proxy?.setMode("open");
          proxy?.drop();

          const recovered = yield* Effect.suspend(fresh).pipe(
            Effect.retry({ times: 20, schedule: Schedule.spaced("2 seconds") }),
          );

          assert.deepStrictEqual(
            recovered.map((file) => file.version),
            [null],
          );
        }),
      90_000,
    );
  });
});
