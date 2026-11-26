import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOST_AFTER } from "@/lib/server-reach";

import { reachWatch, RECHECK_MS, STALL_MS } from "./reach-watch";

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
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(RECHECK_MS * 5);

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
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

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
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(server.sent()).toBe(2);
    expect(watch.lost()).toBe(true);
  });

  it("stops rechecking once nothing needs the server any more", async () => {
    const server = serverThat({ up: false });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.connection(DOWN);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
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
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);

    expect(server.sent()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

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

  it("checks at once when a stream fails, and settles on its answer", async () => {
    const server = serverThat({ up: true });
    const watch = reachWatch(server.answers);

    watch.need(true);
    watch.connection(UP);
    watch.hear("doubted");
    await vi.advanceTimersByTimeAsync(0);

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
