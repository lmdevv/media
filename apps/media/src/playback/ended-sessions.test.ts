import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Queue,
  Ref,
  References,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { PlaybackSessionId } from "@media/contracts/ids";

import * as ConvexSessionReports from "../convex/convex-session-reports.ts";
import * as TestConvex from "../testing/test-convex.ts";
import * as EndedSessions from "./ended-sessions.ts";
import * as SessionReports from "./session-reports.ts";
import { SessionReport } from "./stream-liveness.ts";

const sessionId = (id: string) => PlaybackSessionId.make(id);

const ANSWER_WAIT = Duration.seconds(5);

const overConvex = EndedSessions.layer.pipe(
  Layer.provide(ConvexSessionReports.layer),
  Layer.provideMerge(TestConvex.layer),
);

describe("ended sessions", () => {
  it.effect("hears an end from the session itself, whatever its stamp", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(overConvex);
      const convex = Context.get(context, TestConvex.Service);
      const ended = Context.get(context, EndedSessions.Service);

      yield* TestClock.setTime(10_000);
      yield* convex.report("seen", "playing", 0);
      yield* convex.report("late", "playing", 0);

      assert.isFalse(yield* ended.isEnded(sessionId("seen")));
      assert.isFalse(yield* ended.isEnded(sessionId("late")));

      yield* convex.end("seen");

      yield* TestClock.setTime(5_000);
      yield* convex.end("late");

      assert.isTrue(yield* ended.isEnded(sessionId("seen")));
      assert.isTrue(yield* ended.isEnded(sessionId("late")));
    }),
  );

  it.effect("counts a session the owner has no record of as ended", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(overConvex);
      const convex = Context.get(context, TestConvex.Service);
      const ended = Context.get(context, EndedSessions.Service);

      yield* convex.report("known", "paused", 0);

      assert.isTrue(yield* ended.isEnded(sessionId("deleted-or-never-created")));
      assert.isFalse(yield* ended.isEnded(sessionId("known")));
    }),
  );

  it.effect("waits five seconds for a first answer, then answers no until one comes", () =>
    Effect.gen(function* () {
      const answers = yield* Queue.unbounded<SessionReport>();
      const asked: Array<string> = [];

      const reports = Layer.succeed(
        SessionReports.Service,
        SessionReports.Service.of({
          follow: (followed) => {
            asked.push(followed);

            return Stream.fromQueue(answers);
          },
        }),
      );

      const context = yield* Layer.build(EndedSessions.layer.pipe(Layer.provide(reports)));
      const ended = Context.get(context, EndedSessions.Service);
      const quiet = sessionId("quiet");

      const first = yield* Effect.forkChild(ended.isEnded(quiet));
      const second = yield* Effect.forkChild(ended.isEnded(quiet));

      yield* TestClock.adjust(Duration.millis(4_999));

      assert.isUndefined(first.pollUnsafe(), "still waiting for the answer");

      yield* TestClock.adjust(Duration.millis(1));

      assert.isFalse(yield* Fiber.join(first));
      assert.isFalse(yield* Fiber.join(second));
      assert.isFalse(yield* ended.isEnded(quiet), "no second wait");

      yield* Queue.offer(answers, SessionReport.Ended());

      assert.isTrue(
        yield* Effect.yieldNow.pipe(
          Effect.andThen(ended.isEnded(quiet)),
          Effect.repeat({ until: (answer) => answer, times: 100 }),
        ),
      );
      assert.deepStrictEqual(asked, [quiet], "one follow for every question about a session");
    }),
  );

  it.effect(
    "remembers an end after forgetting the session, while the owner is unreachable",
    () =>
      Effect.gen(function* () {
        const reachable = yield* Ref.make(true);
        const asked: Array<string> = [];

        const reports = Layer.succeed(
          SessionReports.Service,
          SessionReports.Service.of({
            follow: (followed) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  asked.push(followed);

                  if (!(yield* Ref.get(reachable))) return Stream.never;

                  return Stream.make(
                    followed === "revoked"
                      ? SessionReport.Ended()
                      : SessionReport.Active({ state: "playing", positionMs: 0 }),
                  ).pipe(Stream.concat(Stream.never));
                }),
              ),
          }),
        );

        const context = yield* Layer.build(EndedSessions.layer.pipe(Layer.provide(reports)));
        const ended = Context.get(context, EndedSessions.Service);
        const revoked = sessionId("revoked");

        assert.isTrue(yield* ended.isEnded(revoked));

        yield* Effect.forEach(
          Array.from({ length: 4096 }, (_, index) => sessionId(`live-${index}`)),
          ended.isEnded,
          { discard: true },
        );
        yield* Ref.set(reachable, false);

        const answer = yield* Effect.forkChild(ended.isEnded(revoked));

        yield* TestClock.adjust(ANSWER_WAIT);

        assert.isTrue(yield* Fiber.join(answer));
        assert.strictEqual(asked.filter((followed) => followed === revoked).length, 1);
      }),
    30_000,
  );

  it.effect("waits five seconds once, however far the clock steps back", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        EndedSessions.layer.pipe(Layer.provide(SessionReports.layerNone)),
      );

      const ended = Context.get(context, EndedSessions.Service);
      const quiet = sessionId("quiet");

      yield* TestClock.setTime(Duration.toMillis(Duration.hours(1)));

      const first = yield* Effect.forkChild(ended.isEnded(quiet));

      yield* TestClock.adjust(ANSWER_WAIT);

      assert.isFalse(yield* Fiber.join(first));

      yield* TestClock.setTime(0);

      const second = yield* Effect.forkChild(ended.isEnded(quiet));

      yield* Effect.yieldNow;

      assert.isDefined(second.pollUnsafe(), "answered without a second wait");
      assert.isFalse(yield* Fiber.join(second));
    }),
  );

  it.effect("follows a session outside the request that first asked about it", () =>
    Effect.gen(function* () {
      const annotated: Array<ReadonlyArray<string>> = [];

      const logger = Logger.make((options) => {
        annotated.push(Object.keys(options.fiber.getRef(References.CurrentLogAnnotations)));
      });

      const context = yield* Layer.build(
        EndedSessions.layer.pipe(
          Layer.provide(SessionReports.layerNone),
          Layer.provide(Logger.layer([logger])),
        ),
      );

      const ended = Context.get(context, EndedSessions.Service);

      const first = yield* Effect.forkChild(
        ended.isEnded(sessionId("quiet")).pipe(Effect.annotateLogs({ requestId: "first" })),
      );

      yield* TestClock.adjust(ANSWER_WAIT);
      yield* Fiber.join(first);

      assert.deepStrictEqual(annotated, [["sessionId"]]);
    }),
  );
});
