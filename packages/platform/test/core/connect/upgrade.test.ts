import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import {
  control,
  idle,
  load,
  plantDevices,
  playing,
  report,
  requested,
  shelf,
  targetIn,
  targets,
} from "../../connect";
import type { Shelf } from "../../connect";
import { enroll, member } from "../../devices";
import { sessionOf } from "../../probe";
import { importRows, newestRows } from "../../rows";
import { refusal, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import { eventually } from "../jobs/driver";

const stack = coreStackFromEnvFile();

/** More than one batch of each table (256 rows). */
const PLANTED = 300;

/** Enough of each table to hold every row the stack's suites leave behind. */
const ROWS_SCANNED = 20_000;

const name = "connect.clearRowsBeforeItems";

const Status = Schema.NullOr(
  Schema.Struct({ cursor: Schema.NullOr(Schema.String), done: Schema.Boolean }),
);

const PlayerRow = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    settled: Schema.Finite,
    playback: Schema.NullOr(Schema.Struct({ domain: Schema.optionalKey(Schema.String) })),
  }),
);

const RequestRow = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    revision: Schema.Finite,
    playing: Schema.optionalKey(Schema.Boolean),
    ask: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
  }),
);

const players = () =>
  newestRows("connectPlayers", ROWS_SCANNED).map((line) => Schema.decodeSync(PlayerRow)(line));

const requests = () =>
  newestRows("connectRequests", ROWS_SCANNED).map((line) => Schema.decodeSync(RequestRow)(line));

const personalDevice = async (signedIn: SignedIn, label: string) => {
  const device = await enroll(signedIn, label);

  return { ...device, signedIn, sessionId: (await sessionOf(signedIn)).sessionId };
};

/** A report as v0.3.0's `core.connect.player.report` stored it: the domain, no item. */
const oldReport = (deviceId: Id<"devices">, reporter: Id<"authSessions">, settled: number) => ({
  deviceId,
  reporter,
  output: { kind: "local" as const },
  playback: { domain: "music" as const, playing: true, positionMs: 5_000 },
  settled,
  reportedAt: Date.now(),
});

/** A request as v0.3.0's `core.connect.targets.control` stored it: a flat transport. */
const oldRequest = (deviceId: Id<"devices">, reporter: Id<"authSessions">) => ({
  deviceId,
  reporter,
  revision: 4,
  playing: false,
  positionMs: 6_000,
  at: Date.now(),
});

/** The device ids of every row in v0.3.0's shapes left in either table. */
const oldRowsLeft = (): ReadonlyArray<string> => [
  ...players().flatMap((row) => (row.playback?.domain === undefined ? [] : [row.deviceId])),
  ...requests().flatMap((row) => (row.playing === undefined ? [] : [row.deviceId])),
];

const playersOf = (deviceIds: ReadonlyArray<string>) =>
  players()
    .filter((row) => deviceIds.includes(row.deviceId))
    .map((row) => ({ settled: row.settled, playback: row.playback === null ? null : "some" }));

const requestsOf = (deviceIds: ReadonlyArray<string>) =>
  requests()
    .filter((row) => deviceIds.includes(row.deviceId))
    .map((row) => ({ revision: row.revision, kind: row.ask?.kind ?? "flat" }));

describe.skipIf(stack === undefined)("Connect rows from v0.3.0", { timeout: 300_000 }, () => {
  let items: Shelf;

  beforeAll(async () => {
    if (stack !== undefined) items = await shelf(stack);
  });

  it("are read as playing and asking nothing, then cleared in place by the migration", async () => {
    if (stack === undefined) return;
    const aiko = await items.share(await member(stack, "aiko"));
    const phone = await personalDevice(await signInAs(stack, aiko.person), "Phone");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");
    const tablet = await personalDevice(await signInAs(stack, aiko.person), "Tablet");
    const speaker = await personalDevice(await signInAs(stack, aiko.person), "Speaker");
    const radio = await personalDevice(await signInAs(stack, aiko.person), "Radio");
    const planted = plantDevices(PLANTED);
    const settledAt3 = [laptop, tablet, speaker];

    importRows("connectPlayers", [
      ...settledAt3.map((device) => oldReport(device.deviceId, device.sessionId, 3)),
      oldReport(radio.deviceId, radio.sessionId, 0),
      ...planted.map((deviceId) => oldReport(deviceId, phone.sessionId, 3)),
    ]);
    importRows("connectRequests", [
      ...settledAt3.map((device) => oldRequest(device.deviceId, device.sessionId)),
      ...planted.map((deviceId) => oldRequest(deviceId, phone.sessionId)),
    ]);

    expect(targetIn(await targets(phone.signedIn), laptop.deviceId)).toMatchObject({
      name: "Laptop",
      playback: null,
    });
    expect(await requested(laptop.signedIn)).toBeNull();
    expect(await refusal(control(phone.signedIn, laptop.deviceId, { playing: false }))).toBe(
      "conflict",
    );

    await report(laptop.signedIn, playing(items.song, 1_000));

    const pause = await control(phone.signedIn, laptop.deviceId, { playing: false });

    expect(pause.revision).toBe(5);
    expect(await requested(laptop.signedIn)).toMatchObject({
      revision: 5,
      ask: { kind: "transport", item: items.song, playing: false },
    });

    await report(tablet.signedIn, playing(items.song, 3_000));

    const waiting = await load(phone.signedIn, radio.deviceId, items.song, 4_000);

    expect(await requested(radio.signedIn)).toMatchObject({ revision: waiting.revision });

    await runFunction(stack, internal.core.schemaMigrations.reset, { name }, Schema.Null);
    await runFunction(stack, internal.core.schemaMigrations.run, {}, Schema.Unknown);
    await eventually(
      "Connect's migration to finish",
      async () => {
        const status = await runFunction(
          stack,
          internal.core.schemaMigrations.status,
          { name },
          Status,
        );

        return status?.done === true ? status : null;
      },
      120_000,
    );

    expect(oldRowsLeft()).toEqual([]);
    expect(playersOf([speaker.deviceId, ...planted])).toEqual(
      Array.from({ length: PLANTED + 1 }, () => ({ settled: 4, playback: null })),
    );
    expect(requestsOf([speaker.deviceId, tablet.deviceId, ...planted])).toEqual(
      Array.from({ length: PLANTED + 2 }, () => ({ revision: 4, kind: "stop" })),
    );
    expect(playersOf([radio.deviceId])).toEqual([{ settled: 0, playback: null }]);
    expect(await requested(radio.signedIn)).toMatchObject({
      revision: waiting.revision,
      ask: { kind: "load", item: items.song, loadRevision: waiting.revision },
    });
    expect(await requested(laptop.signedIn)).toMatchObject({ revision: 5 });
    expect(await requested(tablet.signedIn)).toBeNull();
    expect(targetIn(await targets(phone.signedIn), tablet.deviceId)?.playback).toMatchObject({
      item: items.song,
      playing: true,
      pending: false,
    });

    await report(speaker.signedIn, idle());

    expect(await requested(speaker.signedIn)).toBeNull();

    const loaded = await load(phone.signedIn, speaker.deviceId, items.song, 2_000);

    expect(loaded.revision).toBe(5);
    expect(await requested(speaker.signedIn)).toMatchObject({
      revision: 5,
      ask: { kind: "load", item: items.song, loadRevision: 5 },
    });

    await report(speaker.signedIn, playing(items.song, 2_000, loaded.revision));

    expect(targetIn(await targets(phone.signedIn), speaker.deviceId)?.playback).toMatchObject({
      item: items.song,
      playing: true,
      pending: false,
    });
  });
});
