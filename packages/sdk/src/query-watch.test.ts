import { Internal, NotFound } from "@media/contracts/errors";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";

import * as ConvexTransport from "./convex-transport";
import * as QueryWatch from "./query-watch";
import type { CallError } from "./sdk-errors";
import { TransportError } from "./sdk-errors";
import { clientLayer } from "./testing/client-context";

interface Attempt {
  readonly values: ReadonlyArray<Schema.Json>;
  readonly error?: CallError;
}

const dropped = new TransportError({
  operation: "libraries:list",
  message: "Transport failed during libraries:list: socket closed",
  cause: null,
});

const crashed = new Internal({ message: "The server failed while running libraries:list" });

const missing = new NotFound({ message: "No such item: nothing has that ID" });

const scripted = (script: ReadonlyArray<Attempt>) => {
  const counts = { opened: 0, closed: 0 };

  const transport = ConvexTransport.ConvexTransport.of({
    call: () => Effect.die(new Error("queries only")),
    subscribe: () =>
      Stream.suspend(() => {
        const attempt = script[Math.min(counts.opened, script.length - 1)] ?? { values: [] };

        counts.opened += 1;

        return Stream.fromIterable(attempt.values).pipe(
          Stream.concat(attempt.error === undefined ? Stream.never : Stream.fail(attempt.error)),
          Stream.ensuring(
            Effect.sync(() => {
              counts.closed += 1;
            }),
          ),
        );
      }),
    setAuth: () => Effect.void,
    authenticated: Effect.void,
  });

  const runtime = ManagedRuntime.make(Layer.merge(clientLayer(transport), TestClock.layer()));

  runtimes.push(runtime);

  return {
    counts,
    watch: QueryWatch.make(runtime, "libraries.list", {}),
    advance: (ms: number) =>
      runtime.runPromise(
        Effect.gen(function* () {
          for (let elapsed = 0; elapsed < ms; elapsed += 100) yield* TestClock.adjust(100);
        }),
      ),
  };
};

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, unknown>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

const library = {
  id: "library-1",
  name: "Movies",
  kind: "movies",
};

describe("QueryWatch", () => {
  it("retries a dropped connection with backoff before showing the result", async () => {
    const { counts, watch, advance } = scripted([
      { values: [], error: dropped },
      { values: [], error: dropped },
      { values: [[]] },
    ]);

    const seen: Array<string> = [];

    watch.subscribe(() => seen.push(watch.getSnapshot().status));
    await advance(10_000);

    expect(watch.getSnapshot()).toStrictEqual({ status: "success", data: [] });
    expect(seen).toStrictEqual(["success"]);
    expect(counts.opened).toBe(3);
  });

  it("reports not found at once, without retrying", async () => {
    const { counts, watch, advance } = scripted([{ values: [], error: missing }]);

    watch.subscribe(() => undefined);
    await advance(60_000);

    expect(watch.getSnapshot()).toMatchObject({ status: "error", error: { _tag: "NotFound" } });
    expect(counts.opened).toBe(1);
  });

  it("reports a crashed function at once, without retrying", async () => {
    const { counts, watch, advance } = scripted([{ values: [], error: crashed }]);

    watch.subscribe(() => undefined);
    await advance(60_000);

    expect(watch.getSnapshot()).toMatchObject({ status: "error", error: { _tag: "Internal" } });
    expect(counts.opened).toBe(1);
  });

  it("reports a transient failure after four retries", async () => {
    const { counts, watch, advance } = scripted([{ values: [], error: dropped }]);

    watch.subscribe(() => undefined);
    await advance(60_000);

    expect(watch.getSnapshot()).toMatchObject({
      status: "error",
      error: { _tag: "TransportError" },
    });
    expect(counts.opened).toBe(5);
  });

  it("starts the retry count over after each result", async () => {
    const { counts, watch, advance } = scripted([
      { values: [[]], error: dropped },
      { values: [[]], error: dropped },
      { values: [[]], error: dropped },
      { values: [[]], error: dropped },
      { values: [[]], error: dropped },
      { values: [[]] },
    ]);

    watch.subscribe(() => undefined);
    await advance(60_000);

    expect(watch.getSnapshot()).toStrictEqual({ status: "success", data: [] });
    expect(counts.opened).toBe(6);
  });

  it("subscribes again from loading when retried", async () => {
    const { counts, watch, advance } = scripted([{ values: [], error: missing }, { values: [[]] }]);
    const seen: Array<string> = [];

    watch.subscribe(() => seen.push(watch.getSnapshot().status));
    await advance(100);

    const failed = watch.getSnapshot();

    if (failed.status !== "error") throw new Error(`Expected a failure, got ${failed.status}`);
    failed.retry();
    await advance(100);

    expect(watch.getSnapshot()).toStrictEqual({ status: "success", data: [] });
    expect(seen).toStrictEqual(["error", "loading", "success"]);
    expect(counts.opened).toBe(2);
  });

  it("starts afresh, without the old failure, when a listener comes back", async () => {
    const { counts, watch, advance } = scripted([{ values: [], error: missing }, { values: [] }]);

    const leave = watch.subscribe(() => undefined);

    await advance(100);
    leave();

    expect(watch.getSnapshot()).toMatchObject({ status: "error" });

    const seen: Array<string> = [];

    watch.subscribe(() => seen.push(watch.getSnapshot().status));

    expect(watch.getSnapshot()).toStrictEqual({ status: "loading" });
    expect(seen).toStrictEqual(["loading"]);
    expect(counts.opened).toBe(2);
  });

  it("decodes each result with the command's schema", async () => {
    const { watch, advance } = scripted([{ values: [[library]] }]);

    watch.subscribe(() => undefined);
    await advance(100);

    expect(watch.getSnapshot()).toMatchObject({
      status: "error",
      error: { _tag: "ProtocolError" },
    });
  });

  it("runs only while someone listens", async () => {
    const { counts, watch, advance } = scripted([{ values: [[]] }]);

    expect(counts.opened).toBe(0);

    const stop = watch.subscribe(() => undefined);
    const stopAlso = watch.subscribe(() => undefined);

    await advance(100);
    stop();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 1, closed: 0 });

    stopAlso();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 1, closed: 1 });
  });
});
