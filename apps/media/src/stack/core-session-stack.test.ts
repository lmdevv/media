import { Forbidden, Unauthenticated } from "@media/contracts/errors";
import { assert, describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect";

import * as CoreSession from "../core/core-session.ts";
import { findCoreStack } from "../testing/stack-processes.ts";

const core = findCoreStack();

const HostAnswer = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
);

const Issued = Schema.Struct({ key: Schema.String });

const runHost = <A>(
  path: string,
  args: Readonly<Record<string, string>>,
  result: Schema.Decoder<A>,
): Effect.Effect<A> =>
  Effect.promise(async () => {
    const response = await fetch(`${core?.url ?? ""}/api/function`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Convex ${core?.adminKey ?? ""}`,
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });

    return response.text();
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(HostAnswer)),
    Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(result)(value)),
    Effect.orDie,
  );

const createService = runHost(
  "core/accounts/host:createService",
  { name: `media server ${crypto.randomUUID()}` },
  Schema.String,
);

const issueKey = (serviceId: string) =>
  runHost("core/auth/apiKeys:issueServiceKey", { serviceId }, Issued).pipe(
    Effect.map(({ key }) => Redacted.make(key)),
  );

const openSession = (apiKey: Redacted.Redacted) =>
  Layer.build(CoreSession.layer({ convexUrl: core?.url ?? "", apiKey })).pipe(
    Effect.map((context) => Context.get(context, CoreSession.Service)),
    Effect.orDie,
  );

const awaitStatus = (session: CoreSession.Interface, status: CoreSession.Status) =>
  session.status.pipe(
    Effect.repeat({
      until: (current) => current === status,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout(Duration.seconds(20)),
  );

const sessionsCurrent = (session: CoreSession.Interface) =>
  session.run((platform) => platform.core.auth.sessions.current()).pipe(Effect.flip);

describe.skipIf(core === undefined)("the server's core session", () => {
  it.live(
    "signs in with its key, and the core refuses it every command",
    () =>
      Effect.gen(function* () {
        const session = yield* openSession(yield* issueKey(yield* createService));

        yield* awaitStatus(session, "signed-in");

        assert.instanceOf(yield* sessionsCurrent(session), Forbidden);
        assert.strictEqual(yield* session.status, "signed-in");
      }).pipe(Effect.scoped),
    60_000,
  );

  it.live(
    "signs in with a rotated key, which ends the earlier key's session and sign-ins",
    () =>
      Effect.gen(function* () {
        const serviceId = yield* createService;
        const first = yield* issueKey(serviceId);
        const running = yield* openSession(first);

        yield* awaitStatus(running, "signed-in");

        const restarted = yield* openSession(yield* issueKey(serviceId));

        yield* awaitStatus(restarted, "signed-in");

        assert.instanceOf(yield* sessionsCurrent(running), Unauthenticated);
        assert.strictEqual(yield* running.status, "signed-out");
        assert.instanceOf(yield* sessionsCurrent(restarted), Forbidden);

        const stale = yield* openSession(first);

        yield* Effect.sleep(Duration.seconds(3));
        assert.strictEqual(yield* stale.status, "signed-out");
        assert.instanceOf(yield* sessionsCurrent(stale), Unauthenticated);
      }).pipe(Effect.scoped),
    60_000,
  );
});
