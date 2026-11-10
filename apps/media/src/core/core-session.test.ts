import { ProtocolError } from "@media/sdk/effect";
import { Unauthenticated } from "@media/contracts/errors";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as CoreSession from "./core-session.ts";

const ping = {
  name: "test.ping",
  kind: "query",
  path: "test:ping",
  args: Schema.Struct({}),
  result: Schema.String,
} as const;

interface FakeCore {
  /** Whether the core accepts the server's key now. */
  readonly accepting: Ref.Ref<boolean>;
  /** Whether the session the server last signed in with still holds. */
  readonly sessionHolds: Ref.Ref<boolean>;
  readonly signIns: Ref.Ref<number>;
}

const refused = () => new Unauthenticated({ message: "The core refused this session" });

/** A core that accepts or refuses the key and ends sessions as the test says. */
const fakeConnection = (core: FakeCore) =>
  Layer.succeed(
    CoreSession.Connection,
    CoreSession.Connection.of({
      signIn: Effect.gen(function* () {
        yield* Ref.update(core.signIns, (count) => count + 1);
        yield* Effect.filterOrFail(Ref.get(core.accepting), (accepting) => accepting, refused);
        yield* Ref.set(core.sessionHolds, true);
      }),
      platform: Effect.die(new Error("This test runs no commands")),
      client: {
        run: (command) =>
          Effect.gen(function* () {
            yield* Effect.filterOrFail(Ref.get(core.sessionHolds), (holds) => holds, refused);

            return yield* Schema.decodeEffect(command.result)("pong").pipe(
              Effect.mapError(
                (cause) =>
                  new ProtocolError({ operation: command.name, message: "bad answer", cause }),
              ),
            );
          }),
        watch: (command) =>
          Stream.fromEffect(
            Schema.decodeEffect(command.result)("pong").pipe(
              Effect.mapError(
                (cause) =>
                  new ProtocolError({ operation: command.name, message: "bad answer", cause }),
              ),
            ),
          ),
      },
    }),
  );

const openSession = (core: FakeCore) =>
  Layer.build(CoreSession.layerFrom.pipe(Layer.provide(fakeConnection(core)))).pipe(
    Effect.map((context) => Context.get(context, CoreSession.Service)),
  );

const makeCore = Effect.all({
  accepting: Ref.make(false),
  sessionHolds: Ref.make(false),
  signIns: Ref.make(0),
});

describe("CoreSession", () => {
  it.effect("keeps signing in with backoff until the core accepts the key", () =>
    Effect.gen(function* () {
      const core = yield* makeCore;
      const session = yield* openSession(core);

      assert.strictEqual(yield* session.status, "signed-out");

      yield* TestClock.adjust("5 seconds");
      assert.isAbove(yield* Ref.get(core.signIns), 2);
      assert.strictEqual(yield* session.status, "signed-out");

      yield* Ref.set(core.accepting, true);
      yield* TestClock.adjust("1 minute");

      assert.strictEqual(yield* session.status, "signed-in");
      assert.strictEqual(yield* session.call(ping, {}), "pong");
    }).pipe(Effect.scoped),
  );

  it.effect("signs in once more when a call finds the session ended", () =>
    Effect.gen(function* () {
      const core = yield* makeCore;

      yield* Ref.set(core.accepting, true);
      const session = yield* openSession(core);

      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* session.status, "signed-in");

      yield* Ref.set(core.sessionHolds, false);
      const before = yield* Ref.get(core.signIns);

      assert.strictEqual(yield* session.call(ping, {}), "pong");
      assert.strictEqual(yield* Ref.get(core.signIns), before + 1);
      assert.strictEqual(yield* session.status, "signed-in");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "signs in again after a refusal even while an older backoff from before a sign-in sleeps",
    () =>
      Effect.gen(function* () {
        const core = yield* makeCore;

        // The first sign-in is refused, so a backoff retry from before any sign-in sleeps.
        const session = yield* openSession(core);

        // A call signs in while that retry still sleeps.
        yield* Ref.set(core.accepting, true);
        assert.strictEqual(yield* session.call(ping, {}), "pong");
        assert.strictEqual(yield* session.status, "signed-in");

        // The core ends the session and refuses the key for a while.
        yield* Ref.set(core.sessionHolds, false);
        yield* Ref.set(core.accepting, false);
        assert.instanceOf(yield* Effect.flip(session.call(ping, {})), Unauthenticated);
        assert.strictEqual(yield* session.status, "signed-out");

        // Once it accepts the key again, the server signs in on its own.
        yield* Ref.set(core.accepting, true);
        yield* TestClock.adjust("2 minutes");

        assert.strictEqual(yield* session.status, "signed-in");
        assert.strictEqual(yield* session.call(ping, {}), "pong");
      }).pipe(Effect.scoped),
  );

  it.effect("subscribes again when a subscription ends without failing", () =>
    Effect.gen(function* () {
      const core = yield* makeCore;

      yield* Ref.set(core.accepting, true);
      const session = yield* openSession(core);

      const answers = yield* session
        .watch(ping, {})
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);

      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual([...(yield* Fiber.join(answers))], ["pong", "pong", "pong"]);
    }).pipe(Effect.scoped),
  );
});
