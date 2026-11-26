import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSED_RECHECK_MS, LOST_AFTER, RECHECK_MS, SETTLE_MS } from "@/lib/server-reach";
import type { Observation } from "@/lib/server-reach";

import { reachWatch, STALL_MS } from "./reach-watch";

/** A health check the test answers by hand, recording each one sent. */
const healthChecks = () => {
  const out: Array<(answered: boolean) => void> = [];
  let sent = 0;

  return {
    answers: () =>
      new Promise<boolean>((resolve) => {
        sent += 1;
        out.push(resolve);
      }),
    sent: () => sent,
    /** Answers the oldest check still out. */
    answer: async (answered: boolean) => {
      out.shift()?.(answered);
      await Promise.resolve();
    },
    /** Answers the newest check still out. */
    answerNewest: async (answered: boolean) => {
      out.pop()?.(answered);
      await Promise.resolve();
    },
  };
};

/** A health check that settles at once with whatever the server does now. */
const serverThat = (answering: { up: boolean }) => {
  let sent = 0;

  return {
    answers: () => {
      sent += 1;

      return Promise.resolve(answering.up);
    },
    sent: () => sent,
  };
};

const UP = { connected: true, waitingSince: null };

const DOWN = { connected: false, waitingSince: null };

describe("reachWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends no health check while the socket stays up and its calls get answers", async () => {
    const server = serverThat({ up: true });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);

    const minutes = async (left: number): Promise<void> => {
      if (left === 0) return;
      watch.connection({ connected: true, waitingSince: Date.now() });
      await vi.advanceTimersByTimeAsync(200);
      watch.connection(UP);
      await vi.advanceTimersByTimeAsync(60_000);
      await minutes(left - 1);
    };

    await minutes(10);

    expect(server.sent()).toBe(0);
    expect(watch.lost()).toBe(false);
  });

  it("calls the server gone a recheck after its socket drops, when the checks go unanswered", async () => {
    const answering = { up: true };
    const server = serverThat(answering);
    const watch = reachWatch(server.answers);
    const heard = vi.fn<() => void>();

    watch.subscribe(heard);
    watch.need(true);
    watch.connection(UP);
    answering.up = false;
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(server.sent()).toBe(1);
    expect(watch.lost()).toBe(false);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(server.sent()).toBe(LOST_AFTER);
    expect(watch.lost()).toBe(true);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("keeps checking while the server is gone and something needs it, and clears at its answer", async () => {
    const answering = { up: false };
    const server = serverThat(answering);
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RECHECK_MS * 5);

    expect(server.sent()).toBe(6);
    expect(watch.lost()).toBe(true);

    answering.up = true;
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(watch.lost()).toBe(false);
    expect(server.sent()).toBe(7);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.sent()).toBe(7);
  });

  it("clears as soon as the socket opens again, without waiting for a check", async () => {
    const server = serverThat({ up: false });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RECHECK_MS);

    expect(watch.lost()).toBe(true);
    watch.connection(UP);

    expect(watch.lost()).toBe(false);
  });

  it("sends nothing while nothing needs the server, as a downloaded song plays in the background", async () => {
    const answering = { up: false };
    const server = serverThat(answering);
    const watch = reachWatch(server.answers);

    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(server.sent()).toBe(0);

    watch.need(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RECHECK_MS);

    expect(server.sent()).toBe(2);
    expect(watch.lost()).toBe(true);
  });

  it("stops rechecking once nothing needs the server any more", async () => {
    const server = serverThat({ up: false });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RECHECK_MS);
    watch.need(false);
    const sent = server.sent();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(server.sent()).toBe(sent);
  });

  it("doubts a server whose call waits past the stall with the socket open", async () => {
    const answering = { up: true };
    const server = serverThat(answering);
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection({ connected: true, waitingSince: Date.now() });
    await vi.advanceTimersByTimeAsync(STALL_MS);

    expect(server.sent()).toBe(0);

    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(server.sent()).toBe(1);
    expect(watch.lost()).toBe(false);
  });

  it("drops the answer of a check that a later check replaced", async () => {
    const checks = healthChecks();
    const watch = reachWatch(checks.answers);

    watch.connection(UP);
    void watch.check();
    void watch.check();
    void watch.check();
    await checks.answerNewest(true);
    await checks.answer(false);
    await checks.answer(false);

    expect(watch.lost()).toBe(false);
  });

  it("checks again when the socket drops while an older check is out, and drops that answer", async () => {
    const checks = healthChecks();
    const watch = reachWatch(checks.answers);

    watch.need(true);
    watch.connection(UP);
    void watch.check();
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(checks.sent()).toBe(2);

    await checks.answer(true);
    await checks.answer(false);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    await checks.answer(false);

    expect(watch.lost()).toBe(true);
  });

  it("lets nothing change it once the app left its connection", async () => {
    const checks = healthChecks();
    const watch = reachWatch(checks.answers);
    const heard = vi.fn<() => void>();

    watch.subscribe(heard);
    watch.need(true);
    watch.connection(UP);
    void watch.check();
    watch.connection(DOWN);
    watch.close();
    await checks.answer(false);
    watch.hear("failed");
    watch.hear("failed");
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(watch.lost()).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    expect(checks.sent()).toBe(1);
    expect(await watch.check()).toBe(false);
    expect(checks.sent()).toBe(1);
  });

  it("sends no check for a socket that drops and opens again within the settle", async () => {
    const server = serverThat({ up: true });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
    watch.connection(UP);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.sent()).toBe(0);
  });

  it("sends one check on coming back on screen, even when the socket dropped while asleep", async () => {
    const server = serverThat({ up: true });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    void watch.check();
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(300);
    watch.connection(UP);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.sent()).toBe(1);
  });

  it("checks a settle after a stream fails, and settles on its answer", async () => {
    const server = serverThat({ up: true });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.hear("doubted");
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(server.sent()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.sent()).toBe(1);
    expect(watch.lost()).toBe(false);
  });

  it("answers whether the server answered, for the player's own decisions", async () => {
    const answering = { up: true };
    const watch = reachWatch(serverThat(answering).answers);

    expect(await watch.check()).toBe(true);
    answering.up = false;
    expect(await watch.check()).toBe(false);
  });
});

/** What the core's socket last told the watch: nothing yet, open, or closed. */
type Socket = "unknown" | "open" | "closed";

/** What the watch last learned of the server, from the table's rows. */
type Learned = "answered" | "doubted" | "failed once" | "lost";

/**
 * The watch's table: the check it has set next, in milliseconds, or null for none, for each row of
 * what the socket last said, what it last learned, and whether anything needs the server (the app
 * on screen, or the server's queue playing). With null, it still hears the socket close, a call
 * stall, the core say the media server went away, and a stream fail.
 */
const scheduledNext = (socket: Socket, learned: Learned, needed: boolean): number | null => {
  if (!needed) return null;

  if (learned === "doubted") return SETTLE_MS;

  if (learned === "failed once" || learned === "lost") return RECHECK_MS;

  return socket === "open" ? null : CLOSED_RECHECK_MS;
};

/** What happens to the watch, with no time passing and every check answered at once. */
type Event =
  | { readonly kind: "socket"; readonly open: boolean }
  | { readonly kind: "need"; readonly needed: boolean }
  | { readonly kind: "hear"; readonly observation: Observation }
  | { readonly kind: "check"; readonly up: boolean };

const event: fc.Arbitrary<Event> = fc.oneof(
  fc.record({ kind: fc.constant("socket" as const), open: fc.boolean() }),
  fc.record({ kind: fc.constant("need" as const), needed: fc.boolean() }),
  fc.record({
    kind: fc.constant("hear" as const),
    observation: fc.constantFrom<Observation>("answered", "doubted", "failed"),
  }),
  fc.record({ kind: fc.constant("check" as const), up: fc.boolean() }),
);

interface Row {
  readonly socket: Socket;
  readonly failures: number;
  readonly doubted: boolean;
  readonly needed: boolean;
}

const failuresAfter: Readonly<Record<Observation, (failures: number) => number>> = {
  answered: () => 0,
  failed: (failures) => failures + 1,
  doubted: (failures) => failures,
};

const learn = (row: Row, observation: Observation): Row => ({
  ...row,
  failures: failuresAfter[observation](row.failures),
  doubted: observation === "doubted",
});

const after = (row: Row, happened: Event): Row => {
  if (happened.kind === "need") return { ...row, needed: happened.needed };

  if (happened.kind === "hear") return learn(row, happened.observation);

  if (happened.kind === "check") return learn(row, happened.up ? "answered" : "failed");

  const socket: Socket = happened.open ? "open" : "closed";
  const moved = socket === row.socket ? row : learn(row, happened.open ? "answered" : "doubted");

  return { ...moved, socket };
};

const learnedOf = ({ failures, doubted }: Row): Learned => {
  if (doubted) return "doubted";

  if (failures >= LOST_AFTER) return "lost";

  return failures === 1 ? "failed once" : "answered";
};

/** The row an event history leaves the watch in, read off the table's terms. */
const rowAfter = (events: ReadonlyArray<Event>) => {
  const row = events.reduce(after, {
    socket: "unknown",
    failures: 0,
    doubted: false,
    needed: false,
  });

  return { socket: row.socket, learned: learnedOf(row), needed: row.needed };
};

/** A watch taken through `events`, with a server whose health the test sets. */
const watchAfter = async (events: ReadonlyArray<Event>) => {
  const answering = { up: true };
  const server = serverThat(answering);
  const watch = reachWatch(server.answers);

  const run = async (rest: ReadonlyArray<Event>): Promise<void> => {
    const [happened, ...later] = rest;

    if (happened === undefined) return;

    if (happened.kind === "socket") watch.connection(happened.open ? UP : DOWN);
    else if (happened.kind === "need") watch.need(happened.needed);
    else if (happened.kind === "hear") watch.hear(happened.observation);
    else {
      answering.up = happened.up;
      await watch.check();
    }

    await run(later);
  };

  await run(events);

  return { watch, server, answering };
};

/** When the watch sends its next check on its own, within a minute; null for none. */
const nextCheckAt = async (server: { readonly sent: () => number }): Promise<number | null> => {
  const before = server.sent();
  const step = 500;

  const wait = async (waited: number): Promise<number | null> => {
    if (waited >= 60_000) return null;
    await vi.advanceTimersByTimeAsync(step);

    return server.sent() > before ? waited + step : wait(waited + step);
  };

  return wait(0);
};

const history = fc.array(event, { maxLength: 12 });

describe("reachWatch's table", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the check its table names for the row any history leaves it in", async () => {
    await fc.assert(
      fc.asyncProperty(history, async (events) => {
        vi.clearAllTimers();
        const { socket, learned, needed } = rowAfter(events);
        const { watch, server } = await watchAfter(events);

        expect(await nextCheckAt(server)).toBe(scheduledNext(socket, learned, needed));
        watch.close();
      }),
      { numRuns: 150 },
    );
  });

  it("finds a server gone within seconds while needed, once the socket closes or the core says so", async () => {
    await fc.assert(
      fc.asyncProperty(history, fc.boolean(), async (events, coreSays) => {
        vi.clearAllTimers();
        const { watch, answering } = await watchAfter(events);

        watch.need(true);
        answering.up = false;

        if (coreSays) watch.hear("doubted");
        else watch.connection(DOWN);

        await vi.advanceTimersByTimeAsync(CLOSED_RECHECK_MS + SETTLE_MS + 2 * RECHECK_MS);

        expect(watch.lost()).toBe(true);
        watch.close();
      }),
      { numRuns: 100 },
    );
  });

  it("finds the server back within a recheck of its first answer while needed", async () => {
    await fc.assert(
      fc.asyncProperty(history, async (events) => {
        vi.clearAllTimers();
        const { watch, answering } = await watchAfter(events);

        watch.need(true);
        answering.up = true;
        await vi.advanceTimersByTimeAsync(CLOSED_RECHECK_MS);

        expect(watch.lost()).toBe(false);
        watch.close();
      }),
      { numRuns: 100 },
    );
  });

  it("checks nothing on its own while nothing needs the server, whatever it heard", async () => {
    await fc.assert(
      fc.asyncProperty(history, async (events) => {
        vi.clearAllTimers();
        const quiet = events.filter((happened) => happened.kind !== "need");
        const { watch, server } = await watchAfter(quiet);

        expect(await nextCheckAt(server)).toBeNull();
        watch.close();
      }),
      { numRuns: 100 },
    );
  });
});
