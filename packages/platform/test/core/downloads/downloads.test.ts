import type { TicketRequest } from "@media/contracts/ticket";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import type { DownloadItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { enroll, listings, member, openTile, sharedAdmin } from "../../devices";
import type { Device, Member } from "../../devices";
import { movie, openItem, seedLibrary, share, unshare, visibleItems } from "../../probe";
import type { Session } from "../../probe";
import { guestOf } from "../../guests";
import { newestRows } from "../../rows";
import { refusal, signIn, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { deploymentTicketKeys } from "../../ticket-keys";
import { eventually } from "../jobs/driver";
import { makeTree, removeTree, writeSized } from "../libraries/files";
import { scanLibrary } from "../libraries/scanner";

const stack = coreStackFromEnvFile();

type Entry = FunctionReturnType<typeof api.core.downloads.list>["page"][number];

type Usage = FunctionReturnType<typeof api.core.downloads.usage>;

const roots: Array<string> = [];

const listed = listings();

afterAll(async () => {
  await listed.clear();
  await Promise.all(roots.map(removeTree));
});

const itemOf = (id: Id<"probeItems">): DownloadItem => ({ kind: "probe", id });

const add = (who: SignedIn, id: Id<"probeItems">): Promise<null> =>
  who.client.mutation(api.core.downloads.add, { item: itemOf(id) });

const fetchOf = (who: SignedIn, id: Id<"probeItems">) =>
  who.client.mutation(api.core.downloads.fetch, { item: itemOf(id) });

const removeOf = (who: SignedIn, id: Id<"probeItems">): Promise<null> =>
  who.client.mutation(api.core.downloads.remove, { item: itemOf(id) });

const Refusal = Schema.Struct({ code: Schema.String, message: Schema.String });

const answerOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "accepted",
    (cause: unknown) => {
      if (!(cause instanceof ConvexError)) return `failed: ${String(cause)}`;

      const { code, message } = Schema.decodeUnknownSync(Refusal)(cause.data);

      return `${code}: ${message}`;
    },
  );

const usageOf = (who: SignedIn): Promise<Usage> => who.client.query(api.core.downloads.usage, {});

const listOf = async (who: SignedIn): Promise<ReadonlyArray<Entry>> =>
  (
    await who.client.query(api.core.downloads.list, {
      paginationOpts: { numItems: 200, cursor: null },
    })
  ).page;

const statesOf = async (who: SignedIn): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    (await listOf(who)).map((entry) => [
      entry.item.id,
      entry.state === "expired" ? `expired:${entry.because}` : entry.state,
    ]),
  );

interface OnDevice extends Member {
  readonly device: Device;
}

const onDevice = async (core: CoreStack, label: string, name = "Phone"): Promise<OnDevice> => {
  const who = await member(core, label);

  return { ...who, device: await enroll(who.signedIn, name) };
};

const sharedLibrary = async (core: CoreStack, manager: Session, reader: Session, count = 3) => {
  const seeded = await seedLibrary(core, manager, {
    name: `films-${unique()}`,
    kind: "movies",
    items: Array.from({ length: count }, (_, n) => movie(`film-${n}.mkv`, n === 0 ? 17 : 0)),
  });

  await share(manager, seeded.libraryId, { kind: "user", userId: reader.userId }, "view");

  return seeded;
};

const libraryOnDisk = async (
  core: CoreStack,
  manager: Member,
  files: Readonly<Record<string, number>>,
) => {
  const root = await makeTree([]);

  roots.push(root);
  await writeSized(root, files);

  const { libraryId } = await manager.signedIn.client.mutation(api.core.libraries.create, {
    name: `disk-${unique()}`,
    kind: "movies",
    folders: [root],
  });

  await scanLibrary(core, "movies", libraryId);

  const ids = await visibleItems(core, manager, libraryId);
  const opened = await Promise.all(ids.map(async (id) => openItem(core, manager, id)));
  const byName = new Map(opened.map((item) => [item.path.slice(root.length + 1), item.itemId]));

  const idOf = (name: string): Id<"probeItems"> => {
    const id = byName.get(name);

    if (id === undefined) throw new Error(`the scan found no ${name}`);

    return id;
  };

  return { root, libraryId, idOf };
};

const DeviceRow = Schema.fromJsonString(
  Schema.Struct({ deviceId: Schema.optional(Schema.String) }),
);

const CounterRow = Schema.fromJsonString(Schema.Struct({ name: Schema.optional(Schema.String) }));

const rowsOfDevice = (table: "downloads" | "downloadCaps", deviceId: Id<"devices">): number =>
  newestRows(table, 1000).filter((line) => Schema.decodeSync(DeviceRow)(line).deviceId === deviceId)
    .length;

const countersOfDevice = (deviceId: Id<"devices">): number =>
  newestRows("counters", 1000).filter((line) =>
    (Schema.decodeSync(CounterRow)(line).name ?? "").endsWith(`:${deviceId}`),
  ).length;

describe.skipIf(stack === undefined)("downloads", { timeout: 300_000 }, () => {
  it("expires what a removed grant allowed, and brings it back with the grant", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko");
    const films = await sharedLibrary(stack, admin, aiko);

    await inOrder(films.itemIds, async (id) => add(aiko.signedIn, id));

    expect(Object.values(await statesOf(aiko.signedIn))).toEqual([
      "available",
      "available",
      "available",
    ]);

    await unshare(admin, films.libraryId, { kind: "user", userId: aiko.userId });

    expect(Object.values(await statesOf(aiko.signedIn))).toEqual([
      "expired:access",
      "expired:access",
      "expired:access",
    ]);

    const [first] = films.itemIds;

    if (first === undefined) throw new Error("no item seeded");

    expect(await fetchOf(aiko.signedIn, first)).toEqual({ state: "expired", because: "access" });
    expect(await refusal(add(aiko.signedIn, first))).toBe("not_found");

    await share(admin, films.libraryId, { kind: "user", userId: aiko.userId }, "view");

    expect(Object.values(await statesOf(aiko.signedIn))).toEqual([
      "available",
      "available",
      "available",
    ]);
  });

  it("reaches a device's live list when the grant behind it is removed", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-live");
    const films = await sharedLibrary(stack, admin, aiko, 1);
    const [film] = films.itemIds;

    if (film === undefined) throw new Error("no item seeded");

    await add(aiko.signedIn, film);

    const device = new ConvexClient(stack.url);
    const seen: Array<string> = [];

    device.setAuth(async () => aiko.signedIn.token);

    const expired = new Promise<void>((resolve) => {
      device.onUpdate(
        api.core.downloads.list,
        { paginationOpts: { numItems: 50, cursor: null } },
        (result) => {
          const state = result.page[0]?.state ?? "none";

          seen.push(state);

          if (state === "expired") resolve();
        },
      );
    });

    try {
      await eventually("the subscription's first answer", async () =>
        seen.length > 0 ? true : null,
      );
      await unshare(admin, films.libraryId, { kind: "user", userId: aiko.userId });
      await expired;
    } finally {
      await device.close();
    }

    expect(seen).toEqual(["available", "expired"]);
  });

  it("expires through a group, the household, and a kid restriction", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const ben = await onDevice(stack, "ben");

    const films = await seedLibrary(stack, admin, {
      name: `family-${unique()}`,
      kind: "movies",
      items: [movie("cartoon.mkv", 0), movie("thriller.mkv", 17)],
    });

    const [cartoon, thriller] = films.itemIds;

    if (cartoon === undefined || thriller === undefined) throw new Error("no items seeded");

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `kids-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: ben.userId,
    });
    await share(admin, films.libraryId, { kind: "group", groupId }, "view");
    await add(ben.signedIn, cartoon);
    await add(ben.signedIn, thriller);

    await admin.signedIn.client.mutation(api.core.permissions.groups.removeMember, {
      groupId,
      userId: ben.userId,
    });

    expect(await statesOf(ben.signedIn)).toEqual({
      [cartoon]: "expired:access",
      [thriller]: "expired:access",
    });

    await share(admin, films.libraryId, { kind: "household" }, "view");

    expect(await statesOf(ben.signedIn)).toEqual({
      [cartoon]: "available",
      [thriller]: "available",
    });

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: ben.userId,
      restrictions: {
        maxMovieAge: 7,
        hideUnrated: false,
        hideExplicitMusic: true,
        libraries: null,
      },
    });

    expect(await statesOf(ben.signedIn)).toEqual({
      [cartoon]: "available",
      [thriller]: "expired:restricted",
    });

    await unshare(admin, films.libraryId, { kind: "household" });

    expect(await statesOf(ben.signedIn)).toEqual({
      [cartoon]: "expired:access",
      [thriller]: "expired:access",
    });
  });

  it("refuses a download past the device's limit, and counts everyone who uses the device", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-cap", "Family iPad");
    const bob = await member(stack, "bob-cap");

    const takeTurn = async (who: Member): Promise<SignedIn> => {
      const here = await signInAs(stack, who.person);

      await enroll(here, "Family iPad", aiko.device.device);

      return here;
    };

    const disk = await libraryOnDisk(stack, admin, { "a.mkv": 400, "b.mkv": 400, "c.mkv": 400 });

    await inOrder([aiko, bob], async (reader) =>
      share(admin, disk.libraryId, { kind: "user", userId: reader.userId }, "view"),
    );

    await admin.signedIn.client.mutation(api.core.downloads.setCap, {
      deviceId: aiko.device.deviceId,
      bytes: 1000,
    });

    await add(aiko.signedIn, disk.idOf("a.mkv"));
    await add(aiko.signedIn, disk.idOf("a.mkv"));

    const bobFirst = await takeTurn(bob);

    await add(bobFirst, disk.idOf("b.mkv"));

    expect(await usageOf(bobFirst)).toEqual({
      bytes: 800,
      items: 2,
      capBytes: 1000,
      capItems: 500,
    });

    const aikoAgain = await takeTurn(aiko);
    const refused = add(aikoAgain, disk.idOf("c.mkv"));

    await expect(refused).rejects.toThrow(/take 800 bytes of its 1\.0 KB limit/u);
    expect(await refusal(add(aikoAgain, disk.idOf("c.mkv")))).toBe("conflict");

    const bobAgain = await takeTurn(bob);

    expect(await statesOf(bobAgain)).toEqual({ [disk.idOf("b.mkv")]: "available" });
    await removeOf(bobAgain, disk.idOf("b.mkv"));
    await add(await takeTurn(aiko), disk.idOf("c.mkv"));

    const bobLast = await takeTurn(bob);

    expect(await usageOf(bobLast)).toMatchObject({ bytes: 800, items: 2 });
    expect(await refusal(add(bobLast, disk.idOf("b.mkv")))).toBe("conflict");

    await admin.signedIn.client.mutation(api.core.downloads.setCap, {
      deviceId: aiko.device.deviceId,
      bytes: null,
    });

    await add(bobLast, disk.idOf("b.mkv"));

    expect(await usageOf(bobLast)).toMatchObject({ bytes: 1200, items: 3 });
    expect(
      await refusal(
        (await signInAs(stack, aiko.person)).client.mutation(api.core.downloads.setCap, {
          deviceId: aiko.device.deviceId,
          bytes: 1,
        }),
      ),
    ).toBe("forbidden");
  });

  it("lets only as many concurrent downloads in as the limit holds", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-race");
    const sizes = { "1.mkv": 300, "2.mkv": 300, "3.mkv": 300, "4.mkv": 300 };
    const disk = await libraryOnDisk(stack, admin, sizes);

    await share(admin, disk.libraryId, { kind: "user", userId: aiko.userId }, "view");
    await admin.signedIn.client.mutation(api.core.downloads.setCap, {
      deviceId: aiko.device.deviceId,
      bytes: 600,
    });

    const outcomes = await Promise.all(
      Object.keys(sizes).map(async (name) => refusal(add(aiko.signedIn, disk.idOf(name)))),
    );

    expect(outcomes.toSorted()).toEqual(["accepted", "accepted", "conflict", "conflict"]);
    expect(await usageOf(aiko.signedIn)).toMatchObject({ bytes: 600, items: 2 });
  });

  it("refuses a guest", async () => {
    if (stack === undefined) return;

    const sharer = await member(stack, "sharer", "admin");

    const films = await seedLibrary(stack, sharer, {
      name: `shared-${unique()}`,
      kind: "movies",
      items: [movie("trailer.mkv", 0)],
    });

    const [trailer] = films.itemIds;

    if (trailer === undefined) throw new Error("no item seeded");

    const visitor = (
      await guestOf(stack, sharer, { domain: "movies", ref: { type: "probeMovie", id: trailer } })
    ).signedIn;

    await expect(add(visitor, trailer)).rejects.toThrow(/Guests cannot download/u);
    expect(await refusal(add(visitor, trailer))).toBe("forbidden");
  });

  it("re-syncs a changed file: the new revision replaces the old and its size moves the total", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-sync");
    const disk = await libraryOnDisk(stack, admin, { "film.mkv": 100 });
    const film = disk.idOf("film.mkv");

    await share(admin, disk.libraryId, { kind: "user", userId: aiko.userId }, "view");
    await add(aiko.signedIn, film);

    const first = await fetchOf(aiko.signedIn, film);

    if (first.state !== "available") throw new Error(`the first fetch was ${first.state}`);

    expect(first).toMatchObject({
      bytes: 100,
      quality: "standard",
      resource: { kind: "file", id: film },
    });

    await writeSized(disk.root, { "film.mkv": 250 });
    await admin.signedIn.client.mutation(api.core.libraries.scan, { libraryId: disk.libraryId });
    await scanLibrary(stack, "movies", disk.libraryId);

    const [listedAfter] = await listOf(aiko.signedIn);

    expect(listedAfter).toMatchObject({ state: "available", bytes: 250 });
    expect(listedAfter?.state === "available" ? listedAfter.revision : null).not.toBe(
      first.revision,
    );
    expect(await usageOf(aiko.signedIn)).toMatchObject({ bytes: 100 });

    const second = await fetchOf(aiko.signedIn, film);

    expect(second).toMatchObject({ state: "available", bytes: 250 });
    expect(second.state === "available" ? second.revision : null).toBe(
      listedAfter?.state === "available" ? listedAfter.revision : undefined,
    );
    expect(await usageOf(aiko.signedIn)).toMatchObject({ bytes: 250, items: 1 });
  });

  it("lists each device's own downloads, and each person's own on a laptop they take turns on", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await member(stack, "aiko-two");
    const laptopSession = await signInAs(stack, aiko.person);
    const phone = await enroll(aiko.signedIn, "Phone");
    const laptop = await enroll(laptopSession, "Laptop");
    const films = await sharedLibrary(stack, admin, aiko);
    const [one, two, three] = films.itemIds;

    if (one === undefined || two === undefined || three === undefined) {
      throw new Error("no items seeded");
    }

    await add(aiko.signedIn, one);
    await add(aiko.signedIn, three);
    await add(laptopSession, two);
    await add(laptopSession, three);

    expect(phone.deviceId).not.toBe(laptop.deviceId);
    expect(await statesOf(aiko.signedIn)).toEqual({ [one]: "available", [three]: "available" });
    expect(await statesOf(laptopSession)).toEqual({ [two]: "available", [three]: "available" });

    const bob = await member(stack, "bob-two");

    await enroll(bob.signedIn, "Laptop", laptop.device);
    await share(admin, films.libraryId, { kind: "user", userId: bob.userId }, "view");
    await add(bob.signedIn, one);

    expect(await statesOf(bob.signedIn)).toEqual({ [one]: "available" });
    expect(await usageOf(bob.signedIn)).toMatchObject({ items: 3 });

    const aikoBack = await signInAs(stack, aiko.person);

    await enroll(aikoBack, "Laptop", laptop.device);

    expect(await statesOf(aikoBack)).toEqual({ [two]: "available", [three]: "available" });
  });

  it("issues a 15-minute download ticket that a play route and its expiry refuse", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-ticket");
    const films = await sharedLibrary(stack, admin, aiko, 1);
    const [film] = films.itemIds;

    if (film === undefined) throw new Error("no item seeded");

    await add(aiko.signedIn, film);

    const before = Date.now();
    const fetched = await fetchOf(aiko.signedIn, film);

    if (fetched.state !== "available") throw new Error(`the fetch was ${fetched.state}`);

    expect(fetched.expiresAt - before).toBeGreaterThan(14 * 60 * 1000);
    expect(fetched.expiresAt - before).toBeLessThanOrEqual(15 * 60 * 1000 + 2000);

    const ring = await deploymentTicketKeys();

    const request = (purposes: TicketRequest["route"]["purposes"]): TicketRequest => ({
      ticket: fetched.ticket,
      route: { purposes, resource: fetched.resource },
      readSession: async () => "live",
    });

    const reasonAt = async (purposes: TicketRequest["route"]["purposes"], now: number) => {
      const admitted = await ring.admit(request(purposes), now);

      return admitted.ok ? "admitted" : admitted.error.reason;
    };

    expect(await reasonAt(["download"], Date.now())).toBe("admitted");
    expect(await reasonAt(["download"], fetched.expiresAt)).toBe("expired");
    expect(await reasonAt(["play"], Date.now())).toBe("wrong_purpose");

    const again = await fetchOf(aiko.signedIn, film);

    expect(
      again.state === "available" ? await reasonAt(["download"], Date.now()) : again.state,
    ).toBe("admitted");
  });

  it("deletes a removed device's downloads, totals, and limit", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-remove", "Old phone");
    const bob = await member(stack, "bob-remove");

    const films = await sharedLibrary(stack, admin, aiko, 120);

    await share(admin, films.libraryId, { kind: "user", userId: bob.userId }, "view");
    await Promise.all(films.itemIds.slice(0, 110).map(async (id) => add(aiko.signedIn, id)));
    await enroll(bob.signedIn, "Old phone", aiko.device.device);
    await Promise.all(films.itemIds.slice(100).map(async (id) => add(bob.signedIn, id)));
    await admin.signedIn.client.mutation(api.core.downloads.setCap, {
      deviceId: aiko.device.deviceId,
      bytes: 10_000,
    });

    expect(rowsOfDevice("downloads", aiko.device.deviceId)).toBe(130);
    expect(rowsOfDevice("downloadCaps", aiko.device.deviceId)).toBe(1);
    expect(countersOfDevice(aiko.device.deviceId)).toBeGreaterThan(0);

    await admin.signedIn.client.mutation(api.core.devices.registry.remove, {
      deviceId: aiko.device.deviceId,
    });

    await eventually(
      "the removed device's downloads to be deleted",
      async () =>
        rowsOfDevice("downloads", aiko.device.deviceId) === 0 &&
        rowsOfDevice("downloadCaps", aiko.device.deviceId) === 0 &&
        countersOfDevice(aiko.device.deviceId) === 0
          ? true
          : null,
      30_000,
    );

    expect(await refusal(listOf(bob.signedIn))).toBe("unauthenticated");
  });

  it("keeps nothing on a shared device, and gives a device made personal again its downloads back", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-shared", "Den TV");
    const films = await sharedLibrary(stack, admin, aiko, 2);
    const [one, two] = films.itemIds;

    if (one === undefined || two === undefined) throw new Error("no items seeded");

    await add(aiko.signedIn, one);
    await listed.adult({ ...aiko, signedIn: await signInAs(stack, aiko.person) });
    await admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
      deviceId: aiko.device.deviceId,
      mode: "shared",
    });

    expect(await refusal(listOf(aiko.signedIn))).toBe("unauthenticated");

    const tile = await openTile(stack, aiko.device, aiko.userId);

    expect(await statesOf(tile)).toEqual({ [one]: "expired:device" });
    await expect(add(tile, two)).rejects.toThrow(/A shared device keeps no downloads/u);
    expect(await fetchOf(tile, one)).toEqual({ state: "expired", because: "device" });

    await admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
      deviceId: aiko.device.deviceId,
      mode: "personal",
    });

    const back = await signInAs(stack, aiko.person);

    await enroll(back, "Den TV", aiko.device.device);

    expect(await statesOf(back)).toEqual({ [one]: "available" });
  });

  it("marks what left the library gone, and refuses a session on no device", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await onDevice(stack, "aiko-gone");
    const films = await sharedLibrary(stack, admin, aiko, 2);
    const [one, two] = films.itemIds;

    if (one === undefined || two === undefined) throw new Error("no items seeded");

    await add(aiko.signedIn, one);
    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId: films.libraryId });

    expect(await statesOf(aiko.signedIn)).toEqual({ [one]: "gone" });
    expect(await fetchOf(aiko.signedIn, one)).toEqual({ state: "gone" });

    await removeOf(aiko.signedIn, one);

    expect(await listOf(aiko.signedIn)).toEqual([]);
    expect(await usageOf(aiko.signedIn)).toMatchObject({ bytes: 0, items: 0 });

    const kept = await sharedLibrary(stack, admin, aiko, 1);
    const [film] = kept.itemIds;

    if (film === undefined) throw new Error("no item seeded");

    const elsewhere = await signInAs(stack, aiko.person);

    expect(await refusal(add(elsewhere, two))).toBe("conflict");
    await expect(add(elsewhere, film)).rejects.toThrow(/on no device/u);
    expect(await refusal(listOf(elsewhere))).toBe("conflict");
    expect(await refusal(fetchOf(elsewhere, film))).toBe("conflict");
    expect(await refusal(usageOf(elsewhere))).toBe("conflict");
  });

  it("answers a guest, a shared-device tile, and a session on no device alike for a missing item and a hidden one", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);

    const seedOne = async (
      name: string,
    ): Promise<{ libraryId: Id<"libraries">; id: Id<"probeItems"> }> => {
      const seeded = await seedLibrary(stack, admin, {
        name: `${name}-${unique()}`,
        kind: "movies",
        items: [movie(`${name}.mkv`, 0)],
      });

      const [id] = seeded.itemIds;

      if (id === undefined) throw new Error("no item seeded");

      return { libraryId: seeded.libraryId, id };
    };

    const hidden = await seedOne("private");
    const missing = await seedOne("removed");

    await admin.signedIn.client.mutation(api.core.libraries.remove, {
      libraryId: missing.libraryId,
    });

    const sharer = await member(stack, "sharer", "admin");

    const shelf = await seedLibrary(stack, sharer, {
      name: `shared-${unique()}`,
      kind: "movies",
      items: [movie("shared.mkv", 0)],
    });

    const [shared] = shelf.itemIds;

    if (shared === undefined) throw new Error("no item seeded");

    const guest = (
      await guestOf(stack, sharer, { domain: "movies", ref: { type: "probeMovie", id: shared } })
    ).signedIn;

    const kai = await onDevice(stack, "kai-tile", "Den TV");

    await listed.adult({ ...kai, signedIn: await signInAs(stack, kai.person) });
    await admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
      deviceId: kai.device.deviceId,
      mode: "shared",
    });

    const tile = await openTile(stack, kai.device, kai.userId);

    const keyed = await member(stack, "keyed");

    const { key } = await keyed.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "downloads",
      scopes: ["movies:play"],
    });

    const deviceless = await signIn(stack, "apiKey", { key });

    const answersFor = async (id: Id<"probeItems">) => ({
      guest: await answerOf(add(guest, id)),
      tile: await answerOf(add(tile, id)),
      deviceless: await answerOf(add(deviceless, id)),
    });

    const toMissing = await answersFor(missing.id);

    expect(await answersFor(hidden.id)).toEqual(toMissing);
    expect(
      [toMissing.guest, toMissing.tile, toMissing.deviceless].map((said) => said.split(":")[0]),
    ).toEqual(["forbidden", "forbidden", "conflict"]);
  });
});
