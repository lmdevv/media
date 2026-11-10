import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { JobFailed } from "./core-jobs.ts";
import { sendAll } from "./core-scan.ts";

describe("sendAll", () => {
  it.effect("sends what the core did not commit again until every item is committed", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
      const items = Array.from({ length: 12 }, (_, index) => index);

      const answers = yield* sendAll(items, 5, (batch) =>
        Ref.update(sent, (seen) => [...seen, batch]).pipe(
          // The core's budget commits at most three items a call.
          Effect.as({ done: Math.min(3, batch.length) }),
        ),
      );

      assert.deepStrictEqual(yield* Ref.get(sent), [
        [0, 1, 2, 3, 4],
        [3, 4, 5, 6, 7],
        [6, 7, 8, 9, 10],
        [9, 10, 11],
      ]);
      assert.deepStrictEqual(
        answers.flatMap((answer) => answer.sent),
        items,
      );
    }),
  );

  it.effect("fails rather than loop when a call commits nothing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(sendAll([1, 2], 500, () => Effect.succeed({ done: 0 })));

      assert.instanceOf(error, JobFailed);
      assert.isTrue(error.retry);
    }),
  );

  it.effect("sends nothing for no items", () =>
    Effect.gen(function* () {
      const answers = yield* sendAll([], 500, () => Effect.die(new Error("sent nothing")));

      assert.deepStrictEqual(answers, []);
    }),
  );
});
