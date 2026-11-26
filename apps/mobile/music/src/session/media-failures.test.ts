import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOST_AFTER, RECHECK_MS, SETTLE_MS } from "@/lib/server-reach";

import { coverFailed, hearMediaFailures, mediaFailed, onMediaDoubt } from "./media-failures";
import { reachWatch } from "./reach-watch";

const UP = { connected: true, waitingSince: null };

/** iOS's words for a cover the media service answered with `status`. */
const coverStatus = (status: number) => ({
  error: `Download marked as failed because of invalid response status code ${String(status)}`,
});

/** A watch with its socket open, needed, hearing the app's failures, with the server's health set by the test. */
const watching = () => {
  const answering = { up: true };
  let sent = 0;

  const watch = reachWatch(() => {
    sent += 1;

    return Promise.resolve(answering.up);
  });

  watch.need(true);
  watch.connection(UP);
  const stop = hearMediaFailures(watch);

  return {
    watch,
    answering,
    sent: () => sent,
    close: () => {
      stop();
      watch.close();
    },
  };
};

describe("the app's failed requests to the media service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Takes any doubt an earlier test left unheard.
    onMediaDoubt(() => undefined)();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the server a settle after a cover gets no answer, and shows it gone when the checks fail", async () => {
    const { watch, answering, sent, close } = watching();

    answering.up = false;
    coverFailed({ error: "Could not connect to the server." });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(sent()).toBe(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(sent()).toBe(LOST_AFTER);
    expect(watch.lost()).toBe(true);
    close();
  });

  it("checks the server when the proxy answers a cover for a media service that is down", async () => {
    const { sent, close } = watching();

    coverFailed(coverStatus(502));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(sent()).toBe(1);
    close();
  });

  it("sends nothing for a cover that isn't there, or a request the service asks to try later", async () => {
    const { watch, sent, close } = watching();

    coverFailed(coverStatus(404));
    mediaFailed(404);
    mediaFailed(401);
    mediaFailed(503);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent()).toBe(0);
    expect(watch.lost()).toBe(false);
    close();
  });

  it("checks once for a burst of failures, and settles on the media server's answer", async () => {
    const { watch, sent, close } = watching();

    for (const status of [null, 502, 504, null, 500]) mediaFailed(status);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent()).toBe(1);
    expect(watch.lost()).toBe(false);
    close();
  });

  it("keeps a failure no watch heard for the next watch, once", async () => {
    mediaFailed(null);
    const first = watching();

    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(first.sent()).toBe(1);
    first.close();

    const second = watching();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(second.sent()).toBe(0);
    second.close();
  });

  it("stops reaching a watch once it stops hearing", async () => {
    const { sent, close } = watching();

    close();
    const after = watching();

    after.close();
    mediaFailed(null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent()).toBe(0);
    expect(after.sent()).toBe(0);
  });
});
