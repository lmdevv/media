import { createPlatform } from "@media/sdk/promise";
import type { PlatformSdk } from "@media/sdk/promise";
import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { Reply } from "@media/sdk/testing/fake-convex";
import { Brand, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { remoteActions } from "./connect-actions";
import { activeDevice, ownDevices } from "./connect-devices";
import { ConnectPlayer, positionAt } from "./connect-player";
import type { ConnectClock, ConnectCommands } from "./connect-player";
import { entry, queueOf, settle, setup, until } from "./testing/controller-harness";
import type { ConnectView } from "./use-connect";

const LAPTOP = "laptop";

const DESK = "desk";

type ReportedPlayback = Exclude<
  Parameters<PlatformSdk["core"]["connect"]["player"]["report"]>[0]["playback"],
  null
>;

type TrackId = Extract<
  Extract<ReportedPlayback["item"], { readonly domain: "music" }>["ref"],
  { readonly type: "track" }
>["id"];

const asTrackId = Brand.nominal<TrackId>();

const Item = Schema.Struct({
  domain: Schema.String,
  ref: Schema.Struct({ type: Schema.String, id: Schema.String }),
});

const decodeReport = Schema.decodeUnknownSync(
  Schema.Struct({
    playback: Schema.NullOr(
      Schema.Struct({ item: Item, playing: Schema.Boolean, positionMs: Schema.Finite }),
    ),
    applied: Schema.Finite,
  }),
);

const decodeControl = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceId: Schema.String,
    playing: Schema.optionalKey(Schema.Boolean),
    positionMs: Schema.optionalKey(Schema.Finite),
  }),
);

type Item = typeof Item.Type;

type Ask = {
  readonly kind: "transport";
  readonly item: Item;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly at: number;
};

type Request = { readonly revision: number; readonly ask: Ask };

type Shown = {
  readonly item: Item;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly at: number;
  readonly pending: boolean;
};

/**
 * The laptop's Connect rows as the core keeps them (ADR 0018): its last report with the settled
 * revision, and the newest request. `shown` merges them as the core's `playbackOf` in
 * `connect/playback.ts` does, for one reporting session that stays online and the play and pause
 * requests `control` makes; loads, stops, and a change of reporter are out of its reach.
 */
class ConnectCore {
  readonly #now: () => number;
  #report: {
    readonly item: Item;
    readonly playing: boolean;
    readonly positionMs: number;
  } | null = null;
  #reportedAt = 0;
  #settled = 0;
  #request: Request | null = null;
  /** Each report and request as it landed, with what controllers saw right after it. */
  readonly writes: Array<{ readonly write: string; readonly shown: Shown | null }> = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  get settled(): number {
    return this.#settled;
  }

  /** `core.connect.player.report`. */
  report(args: ReturnType<typeof decodeReport>): number {
    this.#settled = Math.max(this.#settled, args.applied);
    this.#report = args.playback;
    this.#reportedAt = this.#now();
    this.writes.push({ write: `report:${String(args.applied)}`, shown: this.shown() });

    return this.#reportedAt;
  }

  /** `core.connect.player.requested`. */
  requested(): Request | null {
    return this.#pending();
  }

  /** `core.connect.targets.control`, applied to what controllers see now. */
  control(args: ReturnType<typeof decodeControl>): number | null {
    const current = this.shown();

    if (current === null) return null;
    const now = this.#now();
    const revision = (this.#request?.revision ?? 0) + 1;

    this.#request = {
      revision,
      ask: {
        kind: "transport",
        item: current.item,
        playing: args.playing ?? current.playing,
        positionMs: args.positionMs ?? positionAt(current, now),
        at: now,
      },
    };
    this.writes.push({ write: `control:${String(revision)}`, shown: this.shown() });

    return revision;
  }

  /** `core.connect.targets.list`. */
  list() {
    const shown = this.shown();

    return [
      {
        deviceId: LAPTOP,
        name: "Laptop",
        mode: "personal",
        output: { kind: "local" },
        playback: shown === null ? null : { domain: shown.item.domain, ...shown },
        reportedAt: this.#reportedAt,
      },
    ];
  }

  shown(): Shown | null {
    const report = this.#report;
    const reported = report === null ? null : { ...report, at: this.#reportedAt, pending: false };
    const ask = this.#pending()?.ask ?? null;

    if (ask === null || reported === null || reported.item.ref.id !== ask.item.ref.id) {
      return reported;
    }

    return {
      item: ask.item,
      playing: ask.playing,
      positionMs: ask.positionMs,
      at: ask.at,
      pending: true,
    };
  }

  #pending(): Request | null {
    return this.#request !== null && this.#request.revision > this.#settled ? this.#request : null;
  }
}

/**
 * A person's laptop playing song a and their desk following it, both over the SDK against
 * `ConnectCore`, the laptop on a `heldPlayState` engine.
 */
const twoDevices = async (
  run: (devices: {
    readonly laptop: ReturnType<typeof setup>;
    readonly core: ConnectCore;
    readonly hear: () => Promise<void>;
    /** The desk taps play or pause as its player bar shows the laptop now. */
    readonly tap: () => Promise<void>;
    readonly asked: ReadonlyArray<boolean | undefined>;
  }) => Promise<void>,
): Promise<void> => {
  const laptop = setup({ playCurrent: "1", heldPlayState: true });
  const desk = setup();
  const core = new ConnectCore(() => laptop.clock.now);
  const asked: Array<boolean | undefined> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        yield* fake.handle("core/connect/player:report", (request) =>
          Effect.succeed(
            Reply.Success({ value: { reportedAt: core.report(decodeReport(request.args)) } }),
          ),
        );
        yield* fake.handle("core/connect/player:requested", () =>
          Effect.succeed(Reply.Success({ value: core.requested() })),
        );
        yield* fake.handle("core/connect/targets:control", (request) => {
          const change = decodeControl(request.args);

          asked.push(change.playing);
          const revision = core.control(change);

          return Effect.succeed(
            revision === null
              ? Reply.Failure({ code: "conflict", message: "Nothing plays on that device" })
              : Reply.Success({ value: { revision } }),
          );
        });
        yield* fake.handle("core/connect/targets:list", () =>
          Effect.succeed(Reply.Success({ value: core.list() })),
        );

        const platform = createPlatform({
          url: fake.url,
          signInUrl: fake.signInUrl,
          connection: "http",
        });

        const commands: ConnectCommands = {
          report: async (song, applied, output) => {
            const { reportedAt } = await platform.core.connect.player.report({
              output,
              applied,
              playback:
                song === null
                  ? null
                  : {
                      item: {
                        domain: "music",
                        ref: { type: "track", id: asTrackId(song.trackId) },
                      },
                      playing: song.playing,
                      positionMs: song.positionMs,
                    },
            });

            return reportedAt;
          },
          albumTracks: async () => [],
        };

        const clock: ConnectClock = { now: () => laptop.clock.now, every: () => () => undefined };
        const connect = new ConnectPlayer(laptop.controller, commands, clock);
        const deskPlayer = new ConnectPlayer(desk.controller, commands, clock);

        const tap = async (): Promise<void> => {
          const devices = ownDevices(
            await platform.core.connect.targets.list({}),
            DESK,
            laptop.clock.now,
          );

          const device = activeDevice(devices, null);

          if (device === null) throw new Error("The desk follows no device");

          const view: ConnectView = {
            deviceId: DESK,
            devices,
            remote: device,
            here: false,
            player: deskPlayer,
            lead: async () => undefined,
            playbackOf: (id) => devices.find((listed) => listed.id === id)?.playback ?? null,
            serverNow: () => laptop.clock.now,
          };

          await remoteActions({
            platform,
            controller: desk.controller,
            connect: view,
            device,
            entries: [],
            index: null,
            repeat: "off",
            durationMs: 200_000,
          }).togglePlay();
        };

        yield* Effect.promise(async () => {
          const stopConnect = connect.start();

          try {
            await laptop.controller.playTracks(["a", "b"], 0);
            laptop.controller.sync(queueOf([entry("a", "1"), entry("b", "2")], "1"));
            await settle();
            laptop.engine().answer();
            await until(() => core.shown()?.playing === true);

            await run({
              laptop,
              core,
              hear: async () => {
                connect.take(await platform.core.connect.player.requested({}));
              },
              tap,
              asked,
            });
          } finally {
            stopConnect();
            laptop.stop();
            desk.stop();
            await platform.dispose();
          }
        });
      }),
    ),
  );
};

/** What controllers saw of the laptop from the write `from` until the write `to`. */
const seenBetween = (core: ConnectCore, from: string, to: string) => {
  const written = core.writes.map(({ write }) => write);
  const start = written.indexOf(from);
  const end = written.indexOf(to);

  expect(start, `${from} landed`).toBeGreaterThanOrEqual(0);
  expect(end, `${to} landed after ${from}`).toBeGreaterThan(start);

  return core.writes.slice(start, end).map(({ shown }) => shown?.playing);
};

describe("a person controlling another of their devices", () => {
  it("plays again with a tap right after a remote pause, while the device's own pause event is on its way", async () => {
    await twoDevices(async ({ laptop, core, hear, tap, asked }) => {
      await tap();
      expect(asked).toEqual([false]);

      await hear();
      await until(() => core.settled === 1);

      await tap();
      expect(asked).toEqual([false, true]);
      expect(seenBetween(core, "control:1", "control:2")).not.toContain(true);

      laptop.engine().answer();
      await hear();
      laptop.engine().answer();
      await until(() => core.shown()?.playing === true && core.shown()?.pending === false);

      expect(laptop.controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
    });
  }, 30_000);

  it("pauses with a tap right after a remote play, while the device's own play event is on its way", async () => {
    await twoDevices(async ({ laptop, core, hear, tap, asked }) => {
      await tap();
      await hear();
      laptop.engine().answer();
      await until(() => core.shown()?.playing === false && core.shown()?.pending === false);

      await tap();
      await hear();
      await until(() => core.settled === 2);

      await tap();
      expect(asked).toEqual([false, true, false]);
      expect(seenBetween(core, "control:2", "control:3")).not.toContain(false);

      laptop.engine().answer();
      await hear();
      laptop.engine().answer();
      await until(() => core.shown()?.playing === false && core.shown()?.pending === false);

      expect(laptop.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
    });
  }, 30_000);
});
