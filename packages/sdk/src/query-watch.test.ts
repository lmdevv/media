import { Internal, NotFound } from "@media/contracts/errors";
import { Effect, ManagedRuntime, Stream } from "effect";
import type { Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";

import * as QueryWatch from "./query-watch";
import type { CallError } from "./sdk-errors";
import { TransportError } from "./sdk-errors";

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

const ignore = (): void => undefined;

const scripted = (script: ReadonlyArray<Attempt>) => {
  const counts = { opened: 0, closed: 0 };

  const results = Stream.suspend(() => {
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
  });

  const runtime = ManagedRuntime.make(TestClock.layer());

  runtimes.push(runtime);

  return {
    counts,
    runtime,
    results,
    watch: QueryWatch.fromStream(runtime, results),
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

  it("counts each subscription, even of one listener twice", async () => {
    const { counts, watch, advance } = scripted([{ values: [[]] }]);
    const stop = watch.subscribe(ignore);
    const stopAlso = watch.subscribe(ignore);

    await advance(100);
    stop();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 1, closed: 0 });

    stopAlso();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 1, closed: 1 });
  });
});

const ONE_MINUTE: QueryWatch.Keep = { idleFor: "1 minute", maxIdle: 10 };

/** A keeper over scripted queries; the first watch of each key opens its own subscription. */
const kept = (script: ReadonlyArray<Attempt>, keep = ONE_MINUTE) => {
  const { counts, runtime, results, advance } = scripted(script);
  const keeper = QueryWatch.keeper(runtime, keep);
  const share = keeper.group<Schema.Json>();
  const built = { watches: 0 };

  return {
    counts,
    built,
    keeper,
    advance,
    watch: (key = "albums") =>
      share(key, () => {
        built.watches += 1;

        return QueryWatch.fromStream(runtime, results);
      }),
  };
};

describe("QueryWatch.keeper", () => {
  it("shares one subscription among the watches of one key", async () => {
    const { counts, built, watch, advance } = kept([{ values: [["a"]] }]);
    const first = watch();
    const second = watch();

    first.subscribe(ignore);
    second.subscribe(ignore);
    await advance(100);

    expect(second).toBe(first);
    expect(second.getSnapshot()).toStrictEqual({ status: "success", data: ["a"] });
    expect({ ...built, ...counts }).toStrictEqual({ watches: 1, opened: 1, closed: 0 });
  });

  it("keeps a query subscribed after its last listener leaves, so the next one has its answer at once", async () => {
    const { counts, built, watch, advance } = kept([{ values: [["a"]] }]);
    const leave = watch().subscribe(ignore);

    await advance(100);
    leave();
    await advance(30_000);

    const again = watch();

    expect(again.getSnapshot()).toStrictEqual({ status: "success", data: ["a"] });

    again.subscribe(ignore);
    // Followed again, so the keep time no longer runs.
    await advance(60_000);

    expect({ ...built, ...counts }).toStrictEqual({ watches: 1, opened: 1, closed: 0 });
  });

  it("stops a query nothing has followed for the keep time", async () => {
    const { counts, built, watch, advance } = kept([{ values: [["a"]] }]);
    const leave = watch().subscribe(ignore);

    await advance(100);
    leave();
    await advance(60_000);

    expect(counts).toStrictEqual({ opened: 1, closed: 1 });
    expect(watch().getSnapshot()).toStrictEqual({ status: "loading" });
    expect(built.watches).toBe(2);
  });

  it("stops the longest idle query once more than the most allowed wait", async () => {
    const { counts, watch, advance } = kept([{ values: [["a"]] }], {
      idleFor: "1 minute",
      maxIdle: 1,
    });

    const leaveFirst = watch("first").subscribe(ignore);
    const leaveSecond = watch("second").subscribe(ignore);

    await advance(100);
    leaveFirst();
    leaveSecond();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 2, closed: 1 });
    expect(watch("second").getSnapshot()).toMatchObject({ status: "success" });
    expect(watch("first").getSnapshot()).toStrictEqual({ status: "loading" });
  });

  it("stops a query as its last listener leaves when the keep time is zero", async () => {
    const { counts, built, watch, advance } = kept([{ values: [["a"]] }], {
      idleFor: 0,
      maxIdle: 10,
    });

    const leave = watch().subscribe(ignore);

    await advance(100);
    leave();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 1, closed: 1 });
    expect(watch().getSnapshot()).toStrictEqual({ status: "loading" });
    expect(built.watches).toBe(2);
  });

  it("never keeps a failed query, so the next listener subscribes again", async () => {
    const { counts, built, watch, advance } = kept([
      { values: [], error: missing },
      { values: [["a"]] },
    ]);

    const leave = watch().subscribe(ignore);

    await advance(100);

    expect(watch().getSnapshot()).toMatchObject({ status: "error", error: { _tag: "NotFound" } });

    leave();

    const again = watch();

    expect(again.getSnapshot()).toStrictEqual({ status: "loading" });

    again.subscribe(ignore);
    await advance(100);

    expect(again.getSnapshot()).toStrictEqual({ status: "success", data: ["a"] });
    expect({ ...built, ...counts }).toStrictEqual({ watches: 2, opened: 2, closed: 1 });
  });

  it("releases every query: idle ones stop, followed ones once their listeners leave", async () => {
    const { counts, keeper, watch, advance } = kept([{ values: [["a"]] }]);
    const leaveIdle = watch("idle").subscribe(ignore);
    const followed = watch("followed");
    const leaveFollowed = followed.subscribe(ignore);

    await advance(100);
    leaveIdle();
    keeper.release();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 2, closed: 1 });
    expect(followed.getSnapshot()).toStrictEqual({ status: "success", data: ["a"] });
    expect(watch("followed")).not.toBe(followed);

    leaveFollowed();
    await advance(100);

    expect(counts).toStrictEqual({ opened: 2, closed: 2 });
  });

  it("releases a watch no one subscribed to once the keep time passes", async () => {
    const { counts, built, watch, advance } = kept([{ values: [["a"]] }]);
    const unused = watch();

    await advance(60_000);

    expect(watch()).not.toBe(unused);
    expect({ ...built, ...counts }).toStrictEqual({ watches: 2, opened: 0, closed: 0 });
  });
});

describe("QueryWatch.whenAnswered", () => {
  it("resolves with the first result and leaves the query kept for the next listener", async () => {
    const { counts, watch, advance } = kept([{ values: [["a"]] }]);
    const answered = QueryWatch.whenAnswered(watch());

    await advance(100);
    await answered;

    expect(watch().getSnapshot()).toStrictEqual({ status: "success", data: ["a"] });
    expect(counts).toStrictEqual({ opened: 1, closed: 0 });
  });

  it("resolves on a failure, without rejecting", async () => {
    const { watch, advance } = kept([{ values: [], error: missing }]);
    const answered = QueryWatch.whenAnswered(watch());

    await advance(100);

    await expect(answered).resolves.toBeUndefined();
  });

  it("resolves at once for a kept answer", async () => {
    const { counts, watch, advance } = kept([{ values: [["a"]] }]);
    const leave = watch().subscribe(ignore);

    await advance(100);
    leave();
    await QueryWatch.whenAnswered(watch());

    expect(counts).toStrictEqual({ opened: 1, closed: 0 });
  });
});
