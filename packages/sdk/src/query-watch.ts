import type { CommandArgs, CommandResult } from "@media/contracts/commands";
import type { Duration, ManagedRuntime } from "effect";
import { Effect, Fiber, Schedule, Stream } from "effect";

import { MoviesClient } from "./movies-client";
import type { QueryName } from "./movies-client";
import type { CallError } from "./sdk-errors";
import { isTransient } from "./sdk-errors";

/**
 * A query's state: loading, its decoded result, or a typed failure with a way to subscribe again.
 * A query that fails after showing a result reports the failure in place of the result.
 */
export type QueryState<A> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: A }
  | {
      readonly status: "error";
      readonly error: CallError;
      /** Subscribes again from `loading`, such as from a Try again button. */
      readonly retry: () => void;
    };

/** One query's state and its listeners. The query runs while at least one listener is attached. */
export interface QueryWatch<A> {
  /** Adds a listener, starting the query for the first; returns its removal. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** The current state; the same object until it changes. */
  readonly getSnapshot: () => QueryState<A>;
}

const LOADING = { status: "loading" } as const;

/** A query that waits, such as one passed `"skip"`: loading, with nothing to subscribe to. */
export const skipped: QueryWatch<never> = {
  subscribe: () => () => undefined,
  getSnapshot: () => LOADING,
};

const retryTransient: Schedule.Schedule<Duration.Duration, CallError> = Schedule.exponential(
  "500 millis",
).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
  Schedule.while(({ input }: { readonly input: CallError }) => isTransient(input)),
);

/**
 * Builds a watch of `results`, run on `runtime`. Nothing runs until the first listener subscribes,
 * and the stream stops when the last one leaves.
 */
export const fromStream = <A, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
  results: Stream.Stream<A, CallError, R>,
): QueryWatch<A> => {
  const listeners = new Set<() => void>();
  let state: QueryState<A> = LOADING;
  let running: Fiber.Fiber<void, unknown> | null = null;

  const publish = (next: QueryState<A>): void => {
    state = next;

    for (const listener of listeners) listener();
  };

  const start = (): void => {
    running = runtime.runFork(
      results.pipe(
        Stream.retry(retryTransient),
        Stream.runForEach((data) => Effect.sync(() => publish({ status: "success", data }))),
        Effect.catch((error) => Effect.sync(() => publish({ status: "error", error, retry }))),
      ),
    );
  };

  const stop = (): void => {
    if (running === null) return;

    Effect.runFork(Fiber.interrupt(running));
    running = null;
  };

  const retry = (): void => {
    if (listeners.size === 0) return;

    stop();
    publish(LOADING);
    start();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);

      if (listeners.size === 1) {
        if (state.status === "error") publish(LOADING);
        start();
      }

      return () => {
        listeners.delete(onChange);

        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => state,
  };
};

/** A watch of query `name` with `args` on the movies backend, run on `runtime`. */
export const make = <Name extends QueryName>(
  runtime: ManagedRuntime.ManagedRuntime<MoviesClient, unknown>,
  name: Name,
  args: CommandArgs<Name>,
): QueryWatch<CommandResult<Name>> =>
  fromStream(
    runtime,
    Stream.unwrap(Effect.map(MoviesClient, (client) => client.subscribe(name, args))),
  );
