import { ConvexReactClient } from "convex/react";
import { Context, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as ConvexTransport from "./convex-transport";
import * as ReactTransport from "./react-transport";
import * as FakeConvex from "./testing/fake-convex";
import { issuedOf, jwtIssuedAt } from "./testing/fake-convex";

/**
 * How often a source that keeps handing back its token was asked before and after `stop` ends
 * the connection's use of it. That token makes the connection ask again, waiting longer each
 * time; stopped, it must not ask any more.
 */
const asksAround = (
  stop: (connection: ConvexTransport.Interface, scope: Scope.Closeable) => Effect.Effect<void>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () => new ConvexReactClient(fake.url, { logger: false, unsavedChangesWarning: false }),
          ),
          (opened) => Effect.promise(() => opened.close()),
        );

        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(ReactTransport.layer(client), scope);
        const connection = Context.get(context, ConvexTransport.ConvexTransport);
        const token = jwtIssuedAt(Date.now(), 3600, "user|session");
        let asked = 0;

        yield* connection.setAuth(() => {
          asked += 1;

          return Promise.resolve(issuedOf(token));
        });
        yield* Effect.sync(() => asked).pipe(
          Effect.repeat({ until: (count) => count >= 2, schedule: Schedule.spaced("50 millis") }),
          Effect.timeout(Duration.seconds(5)),
        );
        yield* stop(connection, scope);
        const stopped = asked;
        const presented = (yield* fake.acceptedTokens).length;

        // Long enough for two more asks at the first waits, one and two seconds.
        yield* Effect.sleep(Duration.seconds(3.5));

        return {
          stopped,
          later: asked,
          presentedAfter: (yield* fake.acceptedTokens).length - presented,
        };
      }),
    ),
  );

describe.concurrent("ReactTransport.layer", () => {
  it("stops asking for a token once signed out", async () => {
    const { stopped, later } = await asksAround((connection) => connection.setAuth(null));

    expect(later).toBe(stopped);
  }, 15_000);

  it("does not present the old token again once signed out", async () => {
    const { presentedAfter } = await asksAround((connection) => connection.setAuth(null));

    expect(presentedAfter).toBe(0);
  }, 15_000);

  it("stops asking for a token once closed, as when its provider unmounts", async () => {
    const { stopped, later } = await asksAround((_, scope) => Scope.close(scope, Exit.void));

    expect(later).toBe(stopped);
  }, 15_000);
});
