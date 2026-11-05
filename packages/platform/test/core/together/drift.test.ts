import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { coreStackFromEnvFile } from "../../stack-env";
import { catalog, guestOf, repeat, waitFor } from "../../together";
import { laneMember, trueNow } from "./lane";
import type { LaneMember } from "./lane";

const stack = coreStackFromEnvFile();

/** How long the members follow the session: 30 s in the stack suite, 300 for the verify lane. */
const SECONDS = Number(process.env["MEDIA_DRIFT_SECONDS"] ?? "30");

const SAMPLE_MS = 100;

/** A sample this soon after a move counts as a transient, while the move reaches both members. */
const SETTLE_MS = 1_000;

const STEP_MS = 10_000;

const percentile = (values: ReadonlyArray<number>, share: number): number => {
  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN;
};

/** The host's script, one move per step, cycling. */
const SCRIPT = [
  (host: LaneMember) =>
    host.control({ kind: "seek", positionMs: 600_000, revision: host.revision() }),
  (host: LaneMember) => host.control({ kind: "pause" }),
  (host: LaneMember) => host.control({ kind: "play" }),
  (host: LaneMember) =>
    host.control({ kind: "seek", positionMs: 60_000, revision: host.revision() }),
] as const;

describe.skipIf(stack === undefined)("the shared clock", { timeout: (SECONDS + 60) * 1000 }, () => {
  it("keeps two members within a quarter second of each other", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "follower");

    const { link } = await shelf.host.signedIn.client.action(api.core.together.create, {
      item: shelf.g,
    });

    await guest.signedIn.client.mutation(api.core.together.join, { domain: "movies", link });

    const host = await laneMember(stack, shelf.host, "movies", {
      skewMs: 0,
      driftPpm: 0,
      returnDelayMs: 0,
    });

    const follower = await laneMember(stack, guest, "movies", {
      skewMs: 3_721,
      driftPpm: 50,
      returnDelayMs: 40,
    });

    const gaps: Array<number> = [];
    const steady: Array<number> = [];
    const reached: Array<number> = [];
    let movedAt = trueNow();

    try {
      await host.control({ kind: "play" });

      const end = trueNow() + SECONDS * 1000;
      let step = 0;
      let nextMove = trueNow() + STEP_MS;

      await repeat(
        () => trueNow() < end,
        SAMPLE_MS,
        async () => {
          if (trueNow() >= nextMove) {
            const clock = await SCRIPT[step % SCRIPT.length]?.(host);

            movedAt = trueNow();
            step += 1;
            nextMove += STEP_MS;

            if (clock !== undefined) {
              await waitFor(() => follower.revision() >= clock.revision, 5_000);
              reached.push(trueNow() - movedAt);
            }
          }

          const at = trueNow();
          const shownByHost = host.shownAt(at);
          const shownByFollower = follower.shownAt(at);

          if (shownByHost === null || shownByFollower === null) return;

          const gap = Math.abs(shownByHost - shownByFollower);

          gaps.push(gap);

          if (at - movedAt > SETTLE_MS) steady.push(gap);
        },
      );
    } finally {
      await Promise.all([host.stop(), follower.stop()]);
    }

    const summary = {
      seconds: SECONDS,
      samples: gaps.length,
      p50: percentile(gaps, 0.5),
      p95: percentile(gaps, 0.95),
      p99: percentile(gaps, 0.99),
      max: Math.max(...gaps),
      steadyMax: Math.max(...steady),
      moves: reached.length,
      slowestMoveMs: Math.max(0, ...reached),
      followerOffsetErrorMs: follower.offsetError(),
    };

    console.info(`together drift ${JSON.stringify(summary)}`);

    expect(gaps.length).toBeGreaterThan(SECONDS * 5);
    expect(summary.p95).toBeLessThan(250);
    expect(summary.steadyMax).toBeLessThan(100);
    expect(summary.slowestMoveMs).toBeLessThan(1_000);
  });
});
