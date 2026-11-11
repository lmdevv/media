import { ProtocolError } from "@media/sdk/effect";
import { assert, describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as BackendHealth from "../backend-health.ts";
import * as CoreSession from "./core-session.ts";
import * as CoreStatus from "./core-status.ts";

/** A signed-in session whose server functions fail their first `failures` calls, then answer. */
const flakySession = (failures: number) =>
  Effect.map(Ref.make(0), (calls) =>
    CoreSession.Service.of({
      status: Effect.succeed("signed-in"),
      run: () => Effect.die(new Error("not used")),
      watch: () => Stream.die(new Error("not used")),
      call: (fn, ..._params) =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count < failures
              ? Effect.fail(
                  new ProtocolError({ operation: "probe", message: "not yet", cause: null }),
                )
              : // The probe asks about a session that cannot exist, which the core answers ended.
                Schema.decodeEffect(fn.result)({ state: "ended" }).pipe(Effect.orDie),
          ),
        ),
    }),
  );

describe("CoreStatus.healthLayer", () => {
  it.effect("asks again soon after an unanswered probe, not a whole interval later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* flakySession(1);

        const built = yield* Layer.build(
          CoreStatus.healthLayer.pipe(Layer.provide(Layer.succeed(CoreSession.Service, session))),
        );

        const health = Context.get(built, BackendHealth.Service);

        yield* TestClock.adjust(Duration.millis(10));
        assert.strictEqual(yield* health.status, "connecting");

        yield* TestClock.adjust(Duration.seconds(2));
        assert.strictEqual(yield* health.status, "connected");
      }),
    ),
  );
});
