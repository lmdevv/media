import { JobId } from "@media/contracts/ids";
import { ConvexTransport, Movies, MoviesClient, TokenStorage } from "@media/sdk/effect";
import { Clock, Context, Duration, Effect, Fiber, Layer, Option, Predicate, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { waitForJobs } from "./jobs";
import { Output } from "./output";

const job = (id: string, status: "running" | "succeeded") => ({
  id,
  kind: "scan",
  status,
  payload: { kind: "scan", libraryId: "library", mode: "full" },
  progress: { done: 0, total: null, message: null },
  error: null,
  requestedBy: null,
  attempts: 1,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
});

interface Pollers {
  open: number;
  most: number;
}

const jobsTransport = (
  finishAt: ReadonlyMap<string, number>,
  pollers: Pollers,
): ConvexTransport.Interface =>
  ConvexTransport.ConvexTransport.of({
    call: () => Effect.never,
    setAuth: () => Effect.void,
    subscribe: (_path, args) => {
      const id = Predicate.isString(args["jobId"]) ? args["jobId"] : "";
      const finish = finishAt.get(id) ?? Number.POSITIVE_INFINITY;

      const updates = Stream.make(job(id, "running")).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.as(Effect.sleep(Duration.millis(finish - now)), job(id, "succeeded")),
            ),
          ),
        ),
        Stream.concat(Stream.never),
      );

      return Stream.unwrap(
        Effect.sync(() => {
          pollers.open += 1;
          pollers.most = Math.max(pollers.most, pollers.open);

          return updates.pipe(
            Stream.ensuring(
              Effect.sync(() => {
                pollers.open -= 1;
              }),
            ),
          );
        }),
      );
    },
  });

const waitWithClock = (finishAt: ReadonlyMap<string, number>, jobIds: ReadonlyArray<string>) => {
  const lines: Array<string> = [];
  const pollers: Pollers = { open: 0, most: 0 };

  const recording = Output.of({
    out: () => Effect.void,
    err: (text) =>
      Effect.sync(() => {
        lines.push(text);
      }),
  });

  return Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.merge(
        TestClock.layer(),
        Movies.layerWithTransport({
          convexUrl: "http://127.0.0.1:9",
          mediaUrl: Option.none(),
        }).pipe(
          Layer.provide(
            Layer.succeed(ConvexTransport.ConvexTransport, jobsTransport(finishAt, pollers)),
          ),
          Layer.provide(TokenStorage.layerMemory),
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const fiber = yield* waitForJobs(
        Context.get(context, MoviesClient.MoviesClient),
        jobIds.map((id) => JobId.make(id)),
        { progress: true, timeout: Duration.seconds(10) },
      ).pipe(Effect.result, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(20));

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provideContext(context));

    return { result, lines, mostPollers: pollers.most };
  }).pipe(Effect.scoped, Effect.provideService(Output, recording), Effect.runPromise);
};

describe("waiting for several jobs", () => {
  it("returns every job once all of them succeed", async () => {
    const { result } = await waitWithClock(
      new Map([
        ["job-a", 6000],
        ["job-b", 9000],
      ]),
      ["job-a", "job-b"],
    );

    expect(result).toMatchObject({
      _tag: "Success",
      success: [
        { id: "job-a", status: "succeeded" },
        { id: "job-b", status: "succeeded" },
      ],
    });
  });

  it("bounds the whole wait by --timeout, not each job", async () => {
    const { result } = await waitWithClock(
      new Map([
        ["job-a", 6000],
        ["job-b", 12_000],
      ]),
      ["job-a", "job-b"],
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "JobError", code: "timeout", jobId: "job-b" },
    });
  });

  it("polls at most four jobs at once, names each in its progress, and keeps one deadline", async () => {
    const ids = ["job-a", "job-b", "job-c", "job-d", "job-e", "job-f"];

    const { result, lines, mostPollers } = await waitWithClock(
      new Map([
        ["job-a", 8000],
        ["job-b", 8000],
        ["job-c", 8000],
        ["job-d", 8000],
        ["job-e", 9000],
        ["job-f", 12_000],
      ]),
      ids,
    );

    expect(mostPollers).toBe(4);

    for (const id of ids) expect(lines).toContain(`scan ${id}: running 0`);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "JobError", code: "timeout", jobId: "job-f" },
    });
  });
});
