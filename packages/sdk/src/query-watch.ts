import type { ManagedRuntime } from "effect";
import { Duration, Effect, Fiber, Schedule, Stream } from "effect";

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
      // Its own entry per subscription, so one function subscribed twice counts twice.
      const listener = (): void => onChange();

      listeners.add(listener);

      if (listeners.size === 1) {
        if (state.status === "error") publish(LOADING);
        start();
      }

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => state,
  };
};

/**
 * Resolves once `watch` has an answer, its result or a failure, following it until then; never
 * rejects. A watch the platform client keeps stays subscribed afterwards, so the screen that follows
 * the same query next, such as the one a route loader prepares, shows the answer at once.
 */
export const whenAnswered = <A>(watch: QueryWatch<A>): Promise<void> =>
  new Promise((resolve) => {
    let stop: (() => void) | null = null;

    const settle = (): void => {
      if (stop === null || watch.getSnapshot().status === "loading") return;

      stop();
      stop = null;
      resolve();
    };

    stop = watch.subscribe(settle);
    // A kept query that already has its answer settles here; subscribing restarted its keep time.
    settle();
  });

/** How long the platform client keeps a query subscribed after its last listener leaves. */
export interface Keep {
  /**
   * How long a query nothing follows stays subscribed with its answer, so a screen that follows
   * it again shows the answer at once. Zero stops it as the last listener leaves.
   */
  readonly idleFor: Duration.Input;
  /** How many queries may stay subscribed with nothing following them; past it the oldest stops. */
  readonly maxIdle: number;
}

/**
 * Five minutes, for at most 50 queries. A query kept subscribed stays live, as Convex pushes its
 * every change, but runs again on the server whenever what it read changes; the bound keeps that
 * cost small. convex-helpers' query cache keeps its queries for the same five minutes.
 */
export const DEFAULT_KEEP: Keep = { idleFor: "5 minutes", maxIdle: 50 };

/** Watches shared by key, and kept subscribed for a while after their last listener leaves. */
export interface Keeper {
  /**
   * A group of watches with one result type, such as one command's: `share(key, open)` gives the
   * watch of `key`, shared by every caller while it is kept, and calls `open` for a new one.
   */
  readonly group: <A>() => (key: string, open: () => QueryWatch<A>) => QueryWatch<A>;
  /** Stops sharing every watch: idle ones stop, and followed ones stop once their listeners leave. */
  readonly release: () => void;
}

/** One shared watch and what keeps it subscribed. */
interface Entry<A> {
  readonly watch: QueryWatch<A>;
  /** The watch callers get, which keeps the query subscribed when its last listener leaves. */
  readonly shared: QueryWatch<A>;
  /** Removes the entry from its group, so the next caller of its key opens a new watch. */
  readonly forget: () => void;
  listeners: number;
  /** Removes the listener that holds the query subscribed while nothing else follows it. */
  hold: (() => void) | null;
  /** Releases the entry once it has been idle for the keep time. */
  expiry: Fiber.Fiber<void, unknown> | null;
  /** No longer shared: it runs until its listeners leave, then stops. */
  released: boolean;
}

const failed = (entry: Entry<unknown>): boolean => entry.watch.getSnapshot().status === "error";

const ignore = (): void => undefined;

/**
 * Shares watches by key and keeps each subscribed for `keep.idleFor` after its last listener
 * leaves. A failed watch is never kept, so the next caller subscribes again, as a new watch would.
 * Effect's `Cache` does not fit: its time to live runs from the lookup, not from the last
 * listener leaving, and a screen must read a kept answer synchronously as it renders.
 *
 * @param runtime - Runs the keep timers.
 */
export const keeper = <R>(
  runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
  keep: Keep,
): Keeper => {
  const idleFor = Duration.fromInputUnsafe(keep.idleFor);
  const shared = new Set<Entry<unknown>>();
  /** Entries nothing follows, oldest first. */
  const idle = new Set<Entry<unknown>>();

  const stopExpiry = (entry: Entry<unknown>): void => {
    if (entry.expiry === null) return;

    Effect.runFork(Fiber.interrupt(entry.expiry));
    entry.expiry = null;
  };

  const release = (entry: Entry<unknown>): void => {
    if (entry.released) return;

    entry.released = true;
    entry.forget();
    shared.delete(entry);
    idle.delete(entry);
    stopExpiry(entry);

    const { hold } = entry;

    entry.hold = null;
    hold?.();
  };

  const rest = (entry: Entry<unknown>): void => {
    if (Duration.isZero(idleFor)) {
      release(entry);

      return;
    }

    idle.add(entry);
    entry.expiry = runtime.runFork(
      Effect.sleep(idleFor).pipe(
        Effect.andThen(
          Effect.sync(() => {
            entry.expiry = null;
            release(entry);
          }),
        ),
      ),
    );

    for (const oldest of idle) {
      if (idle.size <= keep.maxIdle) break;
      release(oldest);
    }
  };

  const share = <A>(watch: QueryWatch<A>, forget: () => void): Entry<A> => {
    const subscribe = (onChange: () => void): (() => void) => {
      entry.listeners += 1;

      if (entry.listeners === 1) {
        idle.delete(entry);
        stopExpiry(entry);
      }

      const stop = watch.subscribe(onChange);
      const { hold } = entry;

      // Dropped only after the listener above joined, so the query never stops in between.
      entry.hold = null;
      hold?.();

      let subscribed = true;

      return () => {
        if (!subscribed) return;

        subscribed = false;
        entry.listeners -= 1;

        if (entry.listeners > 0 || entry.released) {
          stop();

          return;
        }

        if (failed(entry)) {
          stop();
          release(entry);

          return;
        }

        entry.hold = watch.subscribe(ignore);
        stop();
        rest(entry);
      };
    };

    const entry: Entry<A> = {
      watch,
      shared: { subscribe, getSnapshot: watch.getSnapshot },
      forget,
      listeners: 0,
      hold: null,
      expiry: null,
      released: false,
    };

    return entry;
  };

  return {
    group: <A>() => {
      const entries = new Map<string, Entry<A>>();

      return (key: string, open: () => QueryWatch<A>): QueryWatch<A> => {
        const found = entries.get(key);

        if (found !== undefined && (found.listeners > 0 || !failed(found))) return found.shared;

        if (found !== undefined) release(found);

        const entry = share(open(), () => {
          if (entries.get(key) === entry) entries.delete(key);
        });

        entries.set(key, entry);
        shared.add(entry);
        // Idle until its first listener, so a watch no one subscribes to is released in time.
        rest(entry);

        return entry.shared;
      };
    },
    release: () => {
      for (const entry of shared) release(entry);
    },
  };
};
