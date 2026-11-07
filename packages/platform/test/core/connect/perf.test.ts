import { afterAll, describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { live, playing } from "../../connect";
import { listings, member, openTile, sharedAdmin, sharedDevice } from "../../devices";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const WARM_UP = 5;

const COMMANDS = 100;

const BUDGET_MS = 250;

const SHARED_RUNNER_P95_MS = 1000;

const listed = listings();

const percentile = (values: ReadonlyArray<number>, fraction: number): number =>
  values.toSorted((left, right) => left - right)[Math.ceil(values.length * fraction) - 1] ??
  Number.NaN;

const summary = (values: ReadonlyArray<number>): string =>
  `p50 ${percentile(values, 0.5).toFixed(1)} ms, p95 ${percentile(values, 0.95).toFixed(1)} ms, ` +
  `max ${Math.max(...values).toFixed(1)} ms`;

interface Arrival {
  readonly promise: Promise<number>;
  readonly resolve: (at: number) => void;
}

const arrival = (): Arrival => {
  const settlers: Array<(at: number) => void> = [];

  const promise = new Promise<number>((settle) => {
    settlers.push(settle);
  });

  return { promise, resolve: (at) => settlers[0]?.(at) };
};

const arrivals = () => {
  const byKey = new Map<number, Arrival>();

  return (key: number): Arrival => {
    const made = byKey.get(key) ?? arrival();

    byKey.set(key, made);

    return made;
  };
};

describe.skipIf(stack === undefined)("Connect's delay", { timeout: 600_000 }, () => {
  afterAll(async () => {
    await listed.clear();
  });

  it("pauses and plays a shared TV from a phone within 250 ms", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await listed.adult(await member(stack, "lucia"));
    const aiko = await listed.adult(await member(stack, "aiko"));
    const device = await sharedDevice(stack, admin, "Perf TV");
    const tv = live(stack, await openTile(stack, device, lucia.userId));
    const phone = live(stack, aiko.signedIn);

    const seen = arrivals();
    const applied = arrivals();

    await tv.mutation(api.core.connect.player.report, playing(0));

    const stop = tv.onUpdate(api.core.connect.player.requested, {}, (asked) => {
      if (asked === null) return;

      seen(asked.revision).resolve(performance.now());

      void tv
        .mutation(api.core.connect.player.report, {
          output: { kind: "local" },
          playback: { domain: "movies", playing: asked.playing, positionMs: asked.positionMs },
          applied: asked.revision,
        })
        .then(() => applied(asked.revision).resolve(performance.now()));
    });

    const command = async (n: number) => {
      const sent = performance.now();

      const { revision } = await phone.mutation(api.core.connect.targets.control, {
        deviceId: device.deviceId,
        playing: n % 2 === 1,
      });

      const [seenAt, appliedAt] = await Promise.all([
        seen(revision).promise,
        applied(revision).promise,
      ]);

      return { seenMs: seenAt - sent, appliedMs: appliedAt - sent };
    };

    await inOrder(
      Array.from({ length: WARM_UP }, (_, n) => n),
      command,
    );

    const delays = await inOrder(
      Array.from({ length: COMMANDS }, (_, n) => WARM_UP + n),
      command,
    );

    stop();
    await Promise.all([tv.close(), phone.close()]);

    const toTv = delays.map((delay) => delay.seenMs);
    const roundTrip = delays.map((delay) => delay.appliedMs);

    process.stdout.write(
      `[lane delay] ${COMMANDS} pause and play commands from a phone to a shared TV, after ` +
        `${WARM_UP} warm-up commands. Command sent to the TV seeing it: ${summary(toTv)}. ` +
        `Command sent to the TV's report of it committing: ${summary(roundTrip)}\n`,
    );

    expect(delays).toHaveLength(COMMANDS);
    expect(percentile(roundTrip, 0.5)).toBeLessThan(BUDGET_MS);
    expect(percentile(roundTrip, 0.95)).toBeLessThan(SHARED_RUNNER_P95_MS);
  });
});
