import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { ONLINE_MS } from "../../../convex/core/connect/playback";
import { inOrder } from "../../../convex/core/lib/inOrder";
import {
  control,
  idle,
  paused,
  plantDevices,
  playing,
  report,
  requested,
  shelf,
  targetIn,
  targets,
} from "../../connect";
import type { Report, Shelf } from "../../connect";
import { enroll, listings, member, openTile, sharedAdmin, sharedDevice } from "../../devices";
import { sessionOf } from "../../probe";
import { importRows, newestRows } from "../../rows";
import { refusal, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const listed = listings();

const RACES = 5;

const personalDevice = async (signedIn: SignedIn, name: string) => {
  const device = await enroll(signedIn, name);

  return { ...device, signedIn };
};

const connectRowsOf = (deviceId: string): ReadonlyArray<string> =>
  [...newestRows("connectPlayers"), ...newestRows("connectRequests")].filter((row) =>
    row.includes(deviceId),
  );

const lane = (name: string, line: string): void => {
  process.stdout.write(`[lane ${name}] ${line}\n`);
};

describe.skipIf(stack === undefined)("Connect", { timeout: 180_000 }, () => {
  let items: Shelf;

  beforeAll(async () => {
    if (stack !== undefined) items = await shelf(stack);
  });

  afterEach(async () => {
    await listed.clear();
  });

  it("pauses one of a person's devices from another of theirs", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 10_000));

    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)?.playback).toMatchObject({
      domain: "movies",
      playing: true,
      pending: false,
    });

    const { revision } = await control(lucia.signedIn, laptop.deviceId, { playing: false });
    const asked = await requested(laptop.signedIn);

    expect(asked).toMatchObject({
      revision,
      ask: { kind: "transport", item: items.film, playing: false },
    });
    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)?.playback).toMatchObject({
      playing: false,
      pending: true,
    });

    const positionMs = asked?.ask.kind === "transport" ? asked.ask.positionMs : 0;

    await report(laptop.signedIn, paused(items.film, positionMs, revision));

    const after = targetIn(await targets(lucia.signedIn), laptop.deviceId);

    expect(await requested(laptop.signedIn)).toBeNull();
    expect(after?.playback).toMatchObject({ playing: false, pending: false });
    lane(
      "own",
      `revision ${revision} asked ${JSON.stringify(asked)}; after ${JSON.stringify(after)}`,
    );
  });

  it("lets a shared device obey every person it lists and no one else", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await listed.adult(await member(stack, "lucia"));
    const aiko = await listed.adult(await member(stack, "aiko"));
    const bruno = await member(stack, "bruno");
    const tv = await sharedDevice(stack, admin);
    const tile = await openTile(stack, tv, lucia.userId);

    await report(tile, playing(items.film, 5_000));

    const { revision } = await control(aiko.signedIn, tv.deviceId, { playing: false });

    expect(await requested(tile)).toMatchObject({ revision, ask: { playing: false } });
    lane("shared", `aiko (listed) paused lucia's tile on the TV: revision ${revision}`);

    expect(await refusal(control(bruno.signedIn, tv.deviceId, { playing: true }))).toBe(
      "not_found",
    );
    expect(await refusal(control(admin.signedIn, tv.deviceId, { playing: true }))).toBe(
      "not_found",
    );
    expect(targetIn(await targets(bruno.signedIn), tv.deviceId)).toBeUndefined();
    expect(await requested(tile)).toMatchObject({ revision, ask: { playing: false } });
    lane("unlisted", "bruno and the unlisted admin are refused not_found and do not list the TV");
  });

  it("never reaches another person's personal device", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const aiko = await member(stack, "aiko", "admin");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 1_000));

    expect(await refusal(control(aiko.signedIn, laptop.deviceId, { playing: false }))).toBe(
      "not_found",
    );
    expect(targetIn(await targets(aiko.signedIn), laptop.deviceId)).toBeUndefined();
    expect(await requested(laptop.signedIn)).toBeNull();
    lane("personal", "an admin is refused not_found on another person's laptop");
  });

  it("shows a Cast or AirPlay receiver as a target through the device that drives it", async () => {
    if (stack === undefined) return;
    const lucia = await items.share(await member(stack, "lucia"));
    const phone = await personalDevice(await signInAs(stack, lucia.person), "Phone");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(phone.signedIn, {
      output: { kind: "cast", receiver: "  Living room TV " },
      playback: { item: items.song, playing: true, positionMs: 42_000 },
      applied: 0,
    });

    const cast = targetIn(await targets(laptop.signedIn), phone.deviceId);

    expect(cast).toMatchObject({
      name: "Phone",
      mode: "personal",
      output: { kind: "cast", receiver: "Living room TV" },
      playback: { domain: "music", item: items.song, playing: true },
    });

    const { revision } = await control(laptop.signedIn, phone.deviceId, { positionMs: 90_000 });

    expect(await requested(phone.signedIn)).toMatchObject({
      revision,
      ask: { kind: "transport", item: items.song, playing: true, positionMs: 90_000 },
    });

    await report(phone.signedIn, {
      output: { kind: "airplay", receiver: null },
      playback: null,
      applied: revision,
    });

    expect(targetIn(await targets(laptop.signedIn), phone.deviceId)).toMatchObject({
      output: { kind: "airplay", receiver: null },
      playback: null,
    });
    lane("cast", `cast target as listed: ${JSON.stringify(cast)}`);
  });

  it("fails a command cleanly when the device is removed mid-command", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 10_000));

    const { revision } = await control(lucia.signedIn, laptop.deviceId, { playing: false });

    await admin.signedIn.client.mutation(api.core.devices.registry.remove, {
      deviceId: laptop.deviceId,
    });

    expect(await refusal(control(lucia.signedIn, laptop.deviceId, { playing: true }))).toBe(
      "not_found",
    );
    expect(await refusal(report(laptop.signedIn, paused(items.film, 10_100, revision)))).toBe(
      "unauthenticated",
    );
    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)).toBeUndefined();
    expect(connectRowsOf(laptop.deviceId)).toEqual([]);

    const raced = await inOrder(
      Array.from({ length: RACES }, (_, n) => n),
      async (n) => {
        const device = await personalDevice(await signInAs(stack, lucia.person), `Laptop ${n}`);

        await report(device.signedIn, playing(items.film, 1_000));

        const [outcome] = await Promise.all([
          refusal(control(lucia.signedIn, device.deviceId, { playing: false })),
          admin.signedIn.client.mutation(api.core.devices.registry.remove, {
            deviceId: device.deviceId,
          }),
        ]);

        return { outcome, left: connectRowsOf(device.deviceId) };
      },
    );

    expect(raced.every(({ outcome }) => outcome === "accepted" || outcome === "not_found")).toBe(
      true,
    );
    expect(raced.flatMap(({ left }) => left)).toEqual([]);
    lane(
      "removed",
      `after removal: not_found; ${RACES} races: ${raced.map((r) => r.outcome).join(", ")}`,
    );
  });

  it("gives a new tile on a shared device none of the requests made for the last one", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await listed.adult(await member(stack, "lucia"));
    const aiko = await listed.adult(await member(stack, "aiko"));
    const tv = await sharedDevice(stack, admin);
    const luciaTile = await openTile(stack, tv, lucia.userId);

    await report(luciaTile, playing(items.film, 5_000));
    await control(aiko.signedIn, tv.deviceId, { playing: false });

    const aikoTile = await openTile(stack, tv, aiko.userId);

    expect(await refusal(control(aiko.signedIn, tv.deviceId, { playing: false }))).toBe("conflict");
    expect(targetIn(await targets(aiko.signedIn), tv.deviceId)).toBeUndefined();

    await report(aikoTile, idle());

    expect(await refusal(control(aiko.signedIn, tv.deviceId, { playing: true }))).toBe("conflict");

    await report(aikoTile, playing(items.song, 0));

    expect(await requested(aikoTile)).toBeNull();
    expect(targetIn(await targets(lucia.signedIn), tv.deviceId)?.playback).toMatchObject({
      domain: "music",
      playing: true,
      pending: false,
    });
  });

  it("neither lists nor commands a device that went quiet", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");
    const { sessionId } = await sessionOf(laptop.signedIn);

    importRows("connectPlayers", [
      {
        deviceId: laptop.deviceId,
        reporter: sessionId,
        output: { kind: "local" },
        playback: { item: items.film, playing: true, positionMs: 1_000 },
        settled: 0,
        reportedAt: Date.now() - ONLINE_MS - 1_000,
      },
    ]);

    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)).toBeUndefined();
    expect(await refusal(control(lucia.signedIn, laptop.deviceId, { playing: false }))).toBe(
      "conflict",
    );

    await report(laptop.signedIn, playing(items.film, 40_000));

    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)).toBeDefined();
    expect(await refusal(control(lucia.signedIn, laptop.deviceId, { playing: false }))).toBe(
      "accepted",
    );
  });

  it("keeps a request applied when the app that applied it restarts", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 10_000));

    const { revision } = await control(lucia.signedIn, laptop.deviceId, { playing: false });

    await report(laptop.signedIn, paused(items.film, 10_050, revision));
    await report(laptop.signedIn, paused(items.film, 10_050, 0));

    expect(await requested(laptop.signedIn)).toBeNull();
  });

  it("takes reports from an app signed in again after its device changed mode", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 10_000));

    const { revision } = await control(lucia.signedIn, laptop.deviceId, { playing: false });

    await report(laptop.signedIn, paused(items.film, 10_050, revision));

    const setMode = (mode: "personal" | "shared") =>
      admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
        deviceId: laptop.deviceId,
        mode,
      });

    await setMode("shared");
    await setMode("personal");

    const again = await signInAs(stack, lucia.person);

    await enroll(again, "Laptop", laptop.device);

    expect(await refusal(report(again, paused(items.film, 10_050, revision)))).toBe("accepted");
    expect(await refusal(report(again, paused(items.film, 10_050, revision)))).toBe("accepted");
    expect(await requested(again)).toBeNull();

    const next = await control(lucia.signedIn, laptop.deviceId, { playing: true });

    expect(next.revision).toBeGreaterThan(revision);
    expect(await requested(again)).toMatchObject({
      revision: next.revision,
      ask: { playing: true },
    });
  });

  it("drops a request the device missed while it was offline", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");
    const { sessionId } = await sessionOf(laptop.signedIn);
    const wentQuiet = Date.now() - 2 * ONLINE_MS;

    importRows("connectPlayers", [
      {
        deviceId: laptop.deviceId,
        reporter: sessionId,
        output: { kind: "local" },
        playback: { item: items.film, playing: true, positionMs: 1_000 },
        settled: 0,
        reportedAt: wentQuiet,
      },
    ]);
    importRows("connectRequests", [
      {
        deviceId: laptop.deviceId,
        reporter: sessionId,
        revision: 1,
        ask: {
          kind: "transport" as const,
          item: items.film,
          playing: false,
          positionMs: 1_100,
          at: wentQuiet + 100,
        },
      },
    ]);

    await report(laptop.signedIn, playing(items.film, 90_000));

    expect(await requested(laptop.signedIn)).toBeNull();
    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)?.playback).toMatchObject({
      playing: true,
      pending: false,
    });
  });

  it("refuses what is not a command or a report", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    await report(laptop.signedIn, playing(items.film, 10_000));

    expect(await refusal(control(lucia.signedIn, laptop.deviceId, {}))).toBe("invalid_args");
    expect(await refusal(control(lucia.signedIn, laptop.deviceId, { positionMs: -1 }))).toBe(
      "invalid_args",
    );
    expect(await refusal(report(laptop.signedIn, playing(items.film, Number.NaN)))).toBe(
      "invalid_args",
    );
    expect(await refusal(report(laptop.signedIn, playing(items.film, 0, 1.5)))).toBe(
      "invalid_args",
    );
    expect(await refusal(report(laptop.signedIn, playing(items.film, 0, 1)))).toBe("invalid_args");
    expect(await refusal(report(lucia.signedIn, playing(items.film, 0)))).toBe("forbidden");
    expect(await refusal(requested(lucia.signedIn))).toBe("forbidden");
  });

  it("keeps a report whose receiver has no name, or too long a one", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    const shown = async (output: Report["output"]) => {
      await report(laptop.signedIn, { ...playing(items.film, 0), output });

      return targetIn(await targets(lucia.signedIn), laptop.deviceId)?.output;
    };

    expect(await shown({ kind: "cast", receiver: " " })).toEqual({ kind: "cast", receiver: null });
    expect(await shown({ kind: "airplay", receiver: "" })).toEqual({
      kind: "airplay",
      receiver: null,
    });
    expect(await shown({ kind: "cast", receiver: ` ${"\u{1F4FA}".repeat(70)} ` })).toEqual({
      kind: "cast",
      receiver: "\u{1F4FA}".repeat(64),
    });
  });

  it("names a receiver by the rule guest names follow, and drops a name that breaks it", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");

    const shown = async (receiver: string) => {
      await report(laptop.signedIn, {
        ...playing(items.film, 0),
        output: { kind: "cast", receiver },
      });

      return targetIn(await targets(lucia.signedIn), laptop.deviceId)?.output;
    };

    expect(await shown("Den \u202Evt\u202C")).toEqual({ kind: "cast", receiver: null });
    expect(await shown("Den\u0007")).toEqual({ kind: "cast", receiver: null });
    expect(await shown("\u200B\u200B")).toEqual({ kind: "cast", receiver: null });
    expect(await shown(`${"\u0301".repeat(64)}TV`)).toEqual({ kind: "cast", receiver: null });
    expect(await shown("\uFF2C\uFF49\uFF56\uFF49\uFF4E\uFF47 Room")).toEqual({
      kind: "cast",
      receiver: "Living Room",
    });
    expect(await shown("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} TV")).toEqual({
      kind: "cast",
      receiver: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} TV",
    });
  });

  it("lists a live device however many ended sessions a person has elsewhere", async () => {
    if (stack === undefined) return;
    const lucia = await member(stack, "lucia");
    const planted = plantDevices(300);

    const laptopBelow = async (tries: number) => {
      const laptop = await personalDevice(await signInAs(stack, lucia.person), "Laptop");
      const above = planted.filter((deviceId) => deviceId > laptop.deviceId);

      if (above.length > 64) return { laptop, above };

      if (tries === 0) throw new Error(`no laptop sorted below 65 planted devices`);

      return laptopBelow(tries - 1);
    };

    const { laptop, above } = await laptopBelow(20);

    const ended = (deviceId: Id<"devices">) => ({
      userId: lucia.userId,
      expirationTime: Date.now() + 24 * 60 * 60 * 1000,
      generation: -1,
      kind: "password" as const,
      device: { id: deviceId, generation: 0, joined: 1 },
    });

    const [crowded = laptop.deviceId] = above;

    importRows("authSessions", [
      ...Array.from({ length: 64 }, () => ended(crowded)),
      ...above.slice(0, 100).map(ended),
    ]);

    await report(laptop.signedIn, playing(items.film, 1_000));

    expect(targetIn(await targets(lucia.signedIn), laptop.deviceId)?.name).toBe("Laptop");
  });
});
