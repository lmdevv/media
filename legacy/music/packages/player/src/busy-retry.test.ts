import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { delay, retryAfterMs } from "./busy-retry";

const busy = (retryAfter?: string): Response =>
  new Response("busy", {
    status: 503,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });

describe("retryAfterMs", () => {
  it("waits the seconds a busy media service names", () => {
    expect(retryAfterMs(busy("2"))).toBe(2000);
    expect(retryAfterMs(busy(" 1 "))).toBe(1000);
  });

  it("waits a default when the header is missing or not whole seconds", () => {
    for (const header of [undefined, "", "soon", "1.5", "-1", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      expect(retryAfterMs(busy(header))).toBe(2000);
    }
  });

  it("is null for every answer but 503", () => {
    for (const status of [200, 206, 404, 500, 502, 504]) {
      const response = new Response(null, { status, headers: { "Retry-After": "2" } });

      expect(retryAfterMs(response)).toBe(null);
    }
  });

  it("always waits a bounded time", () => {
    fc.assert(
      fc.property(fc.string(), (header) => {
        const wait = retryAfterMs(busy(header)) ?? Number.NaN;

        expect(wait).toBeGreaterThanOrEqual(250);
        expect(wait).toBeLessThanOrEqual(10_000);
      }),
    );
  });
});

describe("delay", () => {
  it("resolves at once when aborted, before or while it waits", async () => {
    const abort = new AbortController();
    const waiting = delay(60_000, abort.signal);

    abort.abort();
    await expect(waiting).resolves.toBeUndefined();
    await expect(delay(60_000, abort.signal)).resolves.toBeUndefined();
  });
});
