import { estimateClockOffset, toServerTime } from "@media/contracts/clock";
import type { ClockOffset, ClockSample } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { ConvexClient } from "convex/browser";
import type { FunctionArgs } from "convex/server";

import type { ContentDomain } from "../../../commands/scopes";
import { api } from "../../../convex/_generated/api";
import { positionAt } from "../../../convex/core/together/clock";
import { HEARTBEAT_MS } from "../../../convex/core/together/model";
import type { Clock } from "../../../convex/core/together/model";
import { inOrder } from "../../../convex/core/lib/inOrder";
import type { Member } from "../../devices";
import type { CoreStack } from "../../stack-env";
import { repeat, sleep } from "../../together";

/** The samples a member keeps for its estimate of the server's clock, as movies' rooms keep. */
const SAMPLES_KEPT = 10;

const BURST = 5;

const BURST_SPACING_MS = 50;

/**
 * How often a member takes a burst of samples. A burst's heartbeats after the first write nothing,
 * so their round trips hold no commit and the shortest of them is a clean sample.
 */
const BURST_EVERY_MS = 30_000;

/** How a lane member's device differs from the true time and the network. */
export interface LaneDevice {
  /** How far its clock runs ahead of the true time. */
  readonly skewMs: number;
  /** How much faster its clock runs, in parts per million. */
  readonly driftPpm: number;
  /** The most extra delay on the way back of each heartbeat; each takes a random share of it. */
  readonly returnDelayMs: number;
}

/** A member following a group session without a player. */
export interface LaneMember {
  /** The position this member shows at a true instant, or null before it has a clock. */
  readonly shownAt: (trueNow: number) => number | null;
  /** The newest revision this member has applied. */
  readonly revision: () => number;
  /** Its estimate's error against the true offset, in milliseconds. */
  readonly offsetError: () => number | null;
  readonly control: (op: FunctionArgs<typeof api.core.together.control>["op"]) => Promise<Clock>;
  readonly stop: () => Promise<void>;
}

/** The true time: one clock every lane member in this process reads. */
export const trueNow = (): number => performance.timeOrigin + performance.now();

/**
 * Starts `who` following their session in `domain` through its own WebSocket client, with movies'
 * rooms' sampling: it stays present with a heartbeat every `HEARTBEAT_MS`, samples the server's
 * clock with a burst of `BURST` heartbeats every `BURST_EVERY_MS`, estimates the offset from the
 * shortest round trip of the last `SAMPLES_KEPT` samples, and applies only newer revisions of the clock it is subscribed to.
 */
export const laneMember = async (
  stack: CoreStack,
  who: Member,
  domain: ContentDomain,
  device: LaneDevice,
): Promise<LaneMember> => {
  const client = new ConvexClient(stack.url, { logger: false });
  const samples: Array<ClockSample> = [];
  let offset: ClockOffset | undefined;
  let applied: Clock | null = null;
  let running = true;

  const localAt = (at: number): number => at * (1 + device.driftPpm * 1e-6) + device.skewMs;

  const apply = (clock: Clock): void => {
    if (applied === null || clock.revision > applied.revision) applied = clock;
  };

  const sample = async (): Promise<void> => {
    const sentAt = localAt(trueNow());
    const { serverTime } = await client.mutation(api.core.together.heartbeat, { domain });

    await sleep(Math.random() * device.returnDelayMs);
    samples.push({
      sentAt,
      serverTime: EpochMillis.make(serverTime),
      receivedAt: localAt(trueNow()),
    });
    samples.splice(0, Math.max(0, samples.length - SAMPLES_KEPT));
    offset = estimateClockOffset(samples);
  };

  client.setAuth(async () => who.signedIn.token);
  client.onUpdate(api.core.together.get, { domain }, (view) => {
    if (view?.state === "joined") apply(view.clock);
  });

  const burst = async (): Promise<void> => {
    await inOrder(
      Array.from({ length: BURST }, (_, taken) => taken),
      async () => {
        await sample();
        await sleep(BURST_SPACING_MS);
      },
    );
  };

  await burst();

  const beating = sleep(HEARTBEAT_MS).then(async () =>
    repeat(
      () => running,
      HEARTBEAT_MS,
      async () => {
        await client.mutation(api.core.together.heartbeat, { domain });
      },
    ),
  );

  const bursting = sleep(BURST_EVERY_MS).then(async () =>
    repeat(() => running, BURST_EVERY_MS, burst),
  );

  return {
    shownAt: (at) =>
      applied === null || offset === undefined
        ? null
        : positionAt(applied, toServerTime(localAt(at), offset)),
    revision: () => applied?.revision ?? -1,
    offsetError: () => {
      if (offset === undefined) return null;

      const now = trueNow();

      return offset.offsetMs - (now - localAt(now));
    },
    control: async (op) => {
      const clock = await client.mutation(api.core.together.control, { domain, op });

      apply(clock);

      return clock;
    },
    stop: async () => {
      running = false;
      await Promise.all([beating, bursting]);
      await client.close();
    },
  };
};
