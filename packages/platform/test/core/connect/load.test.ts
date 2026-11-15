import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import {
  control,
  idle,
  load,
  move,
  paused,
  playing,
  report,
  requested,
  shelf,
  targetIn,
  targets,
} from "../../connect";
import type { Shelf } from "../../connect";
import { enroll, listings, member, openTile, sharedAdmin, sharedDevice } from "../../devices";
import type { Member } from "../../devices";
import { guestsOn, makeLink, openLink } from "../../guests";
import { newestRows } from "../../rows";
import { failureOf, refusal, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const listed = listings();

const RACES = 5;

const MOVE_SLACK_MS = 1_000;

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

type Guests = "follow" | "control";

const session = (host: Member, item: DomainItem, guests: Guests = "follow") =>
  host.signedIn.client.action(api.core.together.create, {
    item,
    join: "open",
    control: guests === "control",
  });

const following = (sessionId: Id<"togetherSessions">, item: DomainItem, positionMs: number) => ({
  output: { kind: "local" as const },
  playback: { item, playing: true, positionMs, session: sessionId },
  applied: 0,
});

const configure = (host: Member, guests: Guests) =>
  host.signedIn.client.mutation(api.core.together.configure, {
    domain: "music",
    join: "open",
    control: guests === "control",
    add: false,
  });

const linkGuest = async (core: CoreStack, host: Member, name: string) => {
  await guestsOn(core);

  const { code } = await makeLink(host, { kind: "session", domain: "music" });

  return openLink(core, code, name);
};

describe.skipIf(stack === undefined)("loading and moving playback", { timeout: 180_000 }, () => {
  let items: Shelf;

  beforeAll(async () => {
    if (stack !== undefined) items = await shelf(stack);
  });

  afterEach(async () => {
    await listed.clear();
  });

  it("lane 2: loads an album onto another of a person's devices at a position", async () => {
    if (stack === undefined) return;
    const aiko = await items.share(await member(stack, "aiko"));
    const phone = await personalDevice(await signInAs(stack, aiko.person), "Phone");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");

    await report(laptop.signedIn, idle());

    const { revision } = await load(phone.signedIn, laptop.deviceId, items.album, 30_000);
    const asked = await requested(laptop.signedIn);

    expect(asked).toMatchObject({
      revision,
      ask: { kind: "load", item: items.album, playing: true, positionMs: 30_000 },
    });
    expect(targetIn(await targets(phone.signedIn), laptop.deviceId)?.playback).toMatchObject({
      domain: "music",
      item: items.album,
      playing: true,
      pending: true,
    });

    await report(laptop.signedIn, playing(items.song, 30_000, revision));

    const shown = targetIn(await targets(phone.signedIn), laptop.deviceId)?.playback;

    expect(shown).toMatchObject({ item: items.song, playing: true, pending: false });
    expect(await requested(laptop.signedIn)).toBeNull();
    lane("load", `asked ${JSON.stringify(asked)}; laptop then reports ${JSON.stringify(shown)}`);
  });

  it("loads a movie onto a shared TV, and plays nothing the person on the TV may not", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await listed.adult(await items.share(await member(stack, "lucia")));
    const kid = await listed.kid(admin, await items.share(await member(stack, "kid")));
    const tv = await sharedDevice(stack, admin);
    const tile = await openTile(stack, tv, kid.userId);

    await report(tile, idle());

    expect(await refusal(load(lucia.signedIn, tv.deviceId, items.film))).toBe("accepted");
    expect(await failureOf(load(lucia.signedIn, tv.deviceId, items.rated))).toEqual({
      code: "forbidden",
      message: "The person on that device cannot play that",
    });

    const explicit = await failureOf(load(lucia.signedIn, tv.deviceId, items.explicit));

    expect(explicit.code).toBe("forbidden");
    expect(await refusal(load(lucia.signedIn, tv.deviceId, items.song))).toBe("accepted");
    expect(await requested(tile)).toMatchObject({ ask: { kind: "load", item: items.song } });
    lane("kid-target", `explicit song onto the kid's tile: ${JSON.stringify(explicit)}`);
  });

  it("refuses an item the caller cannot play as none at all", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const kid = await items.share(await member(stack, "kid"));

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: {
        maxMovieAge: 7,
        hideUnrated: false,
        hideExplicitMusic: true,
        libraries: null,
      },
    });

    const tablet = await personalDevice(await signInAs(stack, kid.person), "Tablet");

    await report(tablet.signedIn, idle());

    expect(await refusal(load(kid.signedIn, tablet.deviceId, items.explicit))).toBe("not_found");
    expect(await refusal(load(kid.signedIn, tablet.deviceId, items.song))).toBe("accepted");
  });

  it("lane 8: never loads onto another person's personal device", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const mateo = await member(stack, "mateo");
    const phone = await personalDevice(await signInAs(stack, mateo.person), "Phone");

    await report(phone.signedIn, idle());

    const refused = await failureOf(load(aiko.signedIn, phone.deviceId, items.song));

    expect(refused.code).toBe("not_found");
    expect(await requested(phone.signedIn)).toBeNull();
    lane("personal", `aiko loading onto mateo's phone: ${JSON.stringify(refused)}`);
  });

  it("refuses a load onto a device that is offline or that it cannot name", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");

    expect(await refusal(load(aiko.signedIn, laptop.deviceId, items.song))).toBe("conflict");

    await report(laptop.signedIn, idle());

    expect(await refusal(load(aiko.signedIn, laptop.deviceId, items.song, -1))).toBe(
      "invalid_args",
    );
  });

  it("lane 9: fails a load onto a device removed mid-load and leaves no row", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const aiko = await items.share(await member(stack, "aiko"));
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");

    const remove = (deviceId: Id<"devices">) =>
      admin.signedIn.client.mutation(api.core.devices.registry.remove, { deviceId });

    await report(laptop.signedIn, idle());
    await remove(laptop.deviceId);

    const refused = await failureOf(load(aiko.signedIn, laptop.deviceId, items.album));

    expect(refused.code).toBe("not_found");
    expect(connectRowsOf(laptop.deviceId)).toEqual([]);

    const raced = await inOrder(
      Array.from({ length: RACES }, (_, n) => n),
      async (n) => {
        const device = await personalDevice(await signInAs(stack, aiko.person), `Laptop ${n}`);

        await report(device.signedIn, idle());

        const [outcome] = await Promise.all([
          refusal(load(aiko.signedIn, device.deviceId, items.album)),
          remove(device.deviceId),
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
      `${JSON.stringify(refused)}; ${RACES} races: ${raced.map((r) => r.outcome).join(", ")}`,
    );
  });

  it("lane 3: moves playback from one device to another at the source's position", async () => {
    if (stack === undefined) return;
    const aiko = await items.share(await member(stack, "aiko"));
    const phone = await personalDevice(await signInAs(stack, aiko.person), "Phone");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");

    await report(laptop.signedIn, idle());
    await report(phone.signedIn, playing(items.song, 42_000));

    const sent = Date.now();
    const { revision } = await move(aiko.signedIn, phone.deviceId, laptop.deviceId);

    const [stop, start] = await Promise.all([
      requested(phone.signedIn),
      requested(laptop.signedIn),
    ]);

    expect(stop?.ask).toMatchObject({ kind: "stop" });
    expect(start).toMatchObject({
      revision,
      ask: { kind: "load", item: items.song, playing: true },
    });

    const at = start?.ask.kind === "load" ? start.ask.positionMs : Number.NaN;
    const source = 42_000 + (Date.now() - sent);

    expect(Math.abs(at - source)).toBeLessThan(MOVE_SLACK_MS);

    await report(phone.signedIn, idle(stop?.revision ?? 0));
    await report(laptop.signedIn, playing(items.song, at, revision));

    const shown = await targets(aiko.signedIn);

    expect(targetIn(shown, phone.deviceId)?.playback).toBeNull();
    expect(targetIn(shown, laptop.deviceId)?.playback).toMatchObject({
      item: items.song,
      playing: true,
      pending: false,
    });
    lane("move", `stop ${JSON.stringify(stop)}; start ${JSON.stringify(start)}`);
  });

  it("keeps a moved source stopped against its late report and late commands", async () => {
    if (stack === undefined) return;
    const aiko = await items.share(await member(stack, "aiko"));
    const phone = await personalDevice(await signInAs(stack, aiko.person), "Phone");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");
    const tablet = await personalDevice(await signInAs(stack, aiko.person), "Tablet");

    await Promise.all([report(laptop.signedIn, idle()), report(tablet.signedIn, idle())]);
    await report(phone.signedIn, paused(items.film, 5_000));
    await move(aiko.signedIn, phone.deviceId, laptop.deviceId);

    expect(await requested(laptop.signedIn)).toMatchObject({
      ask: { kind: "load", item: items.film, playing: false, positionMs: 5_000 },
    });

    await report(phone.signedIn, playing(items.film, 5_200));

    expect(targetIn(await targets(aiko.signedIn), phone.deviceId)?.playback).toBeNull();
    expect(await refusal(control(aiko.signedIn, phone.deviceId, { playing: true }))).toBe(
      "conflict",
    );
    expect(await refusal(move(aiko.signedIn, phone.deviceId, tablet.deviceId))).toBe("conflict");
    expect((await requested(phone.signedIn))?.ask.kind).toBe("stop");
    expect(await requested(tablet.signedIn)).toBeNull();
    expect(await refusal(move(aiko.signedIn, phone.deviceId, phone.deviceId))).toBe("invalid_args");
  });

  it("refuses a move onto a device whose person cannot play what moves", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const aiko = await listed.adult(await items.share(await member(stack, "aiko")));
    const kid = await listed.kid(admin, await items.share(await member(stack, "kid")));
    const phone = await personalDevice(await signInAs(stack, aiko.person), "Phone");
    const tv = await sharedDevice(stack, admin);
    const tile = await openTile(stack, tv, kid.userId);

    await report(tile, idle());
    await report(phone.signedIn, playing(items.explicit, 1_000));

    expect(await refusal(move(aiko.signedIn, phone.deviceId, tv.deviceId))).toBe("forbidden");
    expect(await requested(phone.signedIn)).toBeNull();
    expect(await requested(tile)).toBeNull();
  });

  it("lanes 5 to 7: lets a guest control a TV only in their session, while the host allows it", async () => {
    if (stack === undefined) return;
    const host = await listed.adult(await items.share(await member(stack, "host", "admin")));
    const other = await items.share(await member(stack, "other", "admin"));
    const tv = await sharedDevice(stack, await sharedAdmin(stack));
    const tile = await openTile(stack, tv, host.userId);
    const started = await session(host, items.song);
    const sam = await linkGuest(stack, host, "Sam");

    await report(tile, following(started.sessionId, items.song, 1_000));

    const denied = await failureOf(control(sam.signedIn, tv.deviceId, { playing: false }));

    expect(denied).toEqual({
      code: "forbidden",
      message: "The group session's host has not let guests control playback",
    });
    expect(targetIn(await targets(sam.signedIn), tv.deviceId)).toBeUndefined();

    await configure(host, "control");

    const allowed = await refusal(control(sam.signedIn, tv.deviceId, { playing: false }));

    expect(allowed).toBe("accepted");
    expect(targetIn(await targets(sam.signedIn), tv.deviceId)?.playback).toMatchObject({
      item: items.song,
      playing: false,
      pending: true,
    });
    expect(await refusal(load(sam.signedIn, tv.deviceId, items.song))).toBe("forbidden");

    await load(host.signedIn, tv.deviceId, items.next);

    expect(await refusal(control(sam.signedIn, tv.deviceId, { playing: true }))).toBe("not_found");

    await session(other, items.next, "control");

    const kai = await linkGuest(stack, other, "Kai");
    const outside = await failureOf(control(kai.signedIn, tv.deviceId, { playing: true }));

    expect(outside.code).toBe("not_found");
    expect(targetIn(await targets(kai.signedIn), tv.deviceId)).toBeUndefined();

    await report(tile, paused(items.song, 1_100, 0));

    expect(await refusal(control(sam.signedIn, tv.deviceId, { playing: true }))).toBe("not_found");
    lane("guest-denied", JSON.stringify(denied));
    lane("guest-allowed", allowed);
    lane("guest-outside", JSON.stringify(outside));
  });

  it("refuses a report that follows a session its person is not in", async () => {
    if (stack === undefined) return;
    const host = await items.share(await member(stack, "host"));
    const aiko = await member(stack, "aiko");
    const laptop = await personalDevice(await signInAs(stack, aiko.person), "Laptop");
    const { sessionId, link } = await session(host, items.song);
    const follow = (item: DomainItem) => report(laptop.signedIn, following(sessionId, item, 0));

    expect(await refusal(follow(items.song))).toBe("not_found");
    expect(await refusal(follow(items.film))).toBe("not_found");

    await aiko.signedIn.client.mutation(api.core.together.join, { domain: "music", link });

    expect(await refusal(follow(items.song))).toBe("accepted");
    expect(await refusal(follow(items.film))).toBe("not_found");
  });

  it("lane 10: lets a listed person pause a shared TV in a session that withholds control (D60)", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lucia = await listed.adult(await items.share(await member(stack, "lucia")));
    const mateo = await listed.adult(await member(stack, "mateo"));
    const aiko = await listed.adult(await member(stack, "aiko"));
    const tv = await sharedDevice(stack, admin, "Living room TV");
    const den = await sharedDevice(stack, admin, "Den laptop");
    const tile = await openTile(stack, tv, lucia.userId);
    const denTile = await openTile(stack, den, aiko.userId);
    const { sessionId, link } = await session(lucia, items.song);

    await mateo.signedIn.client.mutation(api.core.together.join, { domain: "music", link });
    await report(tile, following(sessionId, items.song, 1_000));
    await report(denTile, playing(items.next, 2_000));

    const view = await mateo.signedIn.client.query(api.core.together.get, { domain: "music" });

    expect(view).toMatchObject({ state: "joined", role: "guest", may: { control: false } });

    const tvPause = await refusal(control(mateo.signedIn, tv.deviceId, { playing: false }));
    const denPause = await refusal(control(mateo.signedIn, den.deviceId, { playing: false }));

    expect([tvPause, denPause]).toEqual(["accepted", "accepted"]);
    lane("d60", `shared TV in the session: ${tvPause}; personal device marked shared: ${denPause}`);
  });
});
