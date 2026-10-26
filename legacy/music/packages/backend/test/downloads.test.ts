/**
 * Download pins and their manifests against convex-test: what a pin holds as the library changes
 * under it (missing files, in-place changes, re-encodes, re-tags, unclaimed folders, lost access),
 * and the rules for adding, removing, listing, pruning, and purging pins.
 */
import { DeviceId, LibraryId, TrackId, UserId } from "@music/commands/ids";
import type { DownloadPinId } from "@music/commands/ids";
import { DOWNLOAD_PIN_LIMIT } from "@music/commands/models";
import type { DownloadManifest, DownloadTargetKind } from "@music/commands/models";
import { fileRevision } from "@music/commands/revision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { ScannedTrack } from "../convex/lib/catalog";
import { DEVICE_RETAINED_MS } from "../convex/lib/devices";
import { inOrder } from "../convex/lib/sequence";
import {
  MEDIA_SECRET,
  NO_LYRICS,
  drainScheduled,
  makeBackend,
  markMissing,
  signUp,
  upsertFiles,
} from "./backend";
import type { Backend, User } from "./backend";
import { failureCode } from "./harness";

const START = 1_800_000_000_000;

const COVER = "a".repeat(64);

const PHONE = DeviceId.make("phone");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A file of `album` by Band as a scan reports it; its path is its title. */
const file = (
  title: string,
  album: string,
  trackNumber: number,
  extra: Partial<ScannedTrack> = {},
): ScannedTrack => ({
  path: `${album}/${title}.flac`,
  size: 1000 + trackNumber,
  mtimeMs: 1_700_000_000_000,
  title,
  artist: "Band",
  album,
  trackNumber,
  durationMs: 180_000,
  codec: "flac",
  lossless: true,
  artHash: COVER,
  ...NO_LYRICS,
  ...extra,
});

interface Setup {
  readonly backend: Backend;
  readonly admin: User;
  readonly libraryId: Id<"libraries">;
  readonly scan: (files: ReadonlyArray<ScannedTrack>) => Promise<void>;
  readonly trackAt: (path: string) => Promise<Doc<"tracks">>;
}

/** A backend with a claimed, shared library and an admin whose phone has sent a heartbeat. */
const setup = async (): Promise<Setup> => {
  const backend = makeBackend();
  const admin = await signUp(backend, "admin");

  const created = await admin.music.run("libraries.create", {
    name: "Jazz",
    path: "/music/jazz",
    visibility: "shared",
  });

  // Claims the folder, as the media service does before its first batch.
  await upsertFiles(backend, created.libraryId, []);

  const libraryId = await backend.run(async (ctx) =>
    ctx.db.normalizeId("libraries", created.libraryId),
  );

  if (libraryId === null) throw new Error("The library was not created");

  await admin.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });

  return {
    backend,
    admin,
    libraryId,
    scan: async (files) => {
      await backend.mutation(api.media.upsertTracks, {
        secret: MEDIA_SECRET,
        libraryId,
        tracks: [...files],
      });
    },
    trackAt: async (path) => {
      const track = await backend.run(async (ctx) =>
        ctx.db
          .query("tracks")
          .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
          .unique(),
      );

      if (track === null) throw new Error(`No track at ${path}`);

      return track;
    },
  };
};

const pin = async (
  user: User,
  kind: DownloadTargetKind,
  id: string,
  deviceId: DeviceId = PHONE,
): Promise<DownloadPinId> => (await user.music.run("downloads.add", { deviceId, kind, id })).pinId;

const manifest = (user: User, pinId: DownloadPinId): Promise<DownloadManifest> =>
  user.music.read("downloads.manifest", { pinId });

/** Each entry's title and state, in order. */
const entries = async (user: User, pinId: DownloadPinId) =>
  (await manifest(user, pinId)).entries.map((entry) => [entry.track.title, entry.state]);

describe("an album's manifest", () => {
  it("lists its songs in disc and track order with their file revisions, leaving out missing ones", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();

    await scan([
      file("Two", "Kind", 2),
      file("One", "Kind", 1),
      file("Four", "Kind", 1, { discNumber: 2 }),
      file("Three", "Kind", 3),
    ]);

    const one = await trackAt("Kind/One.flac");
    const pinId = await pin(admin, "album", one.albumId);
    const held = await manifest(admin, pinId);

    expect(held.pin).toMatchObject({
      available: true,
      title: "Kind",
      subtitle: "Band",
      artHash: COVER,
      target: { kind: "album", id: one.albumId },
    });
    expect(held.entries.map((entry) => [entry.track.title, entry.state])).toEqual([
      ["One", "fetchable"],
      ["Two", "fetchable"],
      ["Three", "fetchable"],
      ["Four", "fetchable"],
    ]);
    expect(held.entries[0]).toMatchObject({
      rev: fileRevision(one.size, one.mtimeMs),
      artHash: COVER,
    });
    // A like never changes a manifest, so a download's songs carry none.
    expect(held.entries[0]?.track).not.toHaveProperty("liked");

    await markMissing(backend, libraryId, ["Kind/Two.flac"]);

    expect(await entries(admin, pinId)).toEqual([
      ["One", "fetchable"],
      ["Three", "fetchable"],
      ["Four", "fetchable"],
    ]);
  });

  it("gives a file changed in place a new revision, and swaps a re-encoded song for its new ID", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1), file("Two", "Kind", 2)]);
    const one = await trackAt("Kind/One.flac");
    const pinId = await pin(admin, "album", one.albumId);
    const before = await manifest(admin, pinId);

    await scan([file("One", "Kind", 1, { size: 5000, mtimeMs: 1_700_000_100_000 })]);
    const after = await manifest(admin, pinId);

    expect(after.entries[0]?.track.id).toBe(one._id);
    expect(after.entries[0]?.rev).toBe(fileRevision(5000, 1_700_000_100_000));
    expect(after.entries[0]?.rev).not.toBe(before.entries[0]?.rev);

    // Re-encoded under a new name: a new song, and the old one's file is gone.
    await scan([file("One", "Kind", 1, { path: "Kind/One.m4a", codec: "aac", lossless: false })]);
    await markMissing(backend, libraryId, ["Kind/One.flac"]);
    const reencoded = await trackAt("Kind/One.m4a");

    expect((await manifest(admin, pinId)).entries.map((entry) => entry.track.id)).toEqual([
      reencoded._id,
      (await trackAt("Kind/Two.flac"))._id,
    ]);
  });
});

describe("a playlist's manifest", () => {
  it("keeps missing songs as missing, leaves out ones the viewer can't read, and lists each once", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();
    const member = await signUp(backend, "member");

    await member.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });
    await scan([file("A", "Mix", 1), file("B", "Mix", 2)]);

    const secret = await admin.music.run("libraries.create", {
      name: "Secret",
      path: "/music/secret",
      visibility: "private",
    });

    await upsertFiles(backend, secret.libraryId, [{ path: "Hidden.flac", title: "Hidden" }]);
    const [a, b] = await Promise.all([trackAt("Mix/A.flac"), trackAt("Mix/B.flac")]);

    const hidden = await backend.run(async (ctx) =>
      (await ctx.db.query("tracks").collect()).find((track) => track.title === "Hidden"),
    );

    if (hidden === undefined) throw new Error("The private song was not scanned");

    const { playlistId } = await admin.music.run("playlists.create", {
      name: "Road",
      trackIds: [a._id, hidden._id, b._id, a._id].map((id) => TrackId.make(id)),
    });

    await admin.music.run("playlists.visibility", { playlistId, visibility: "shared" });
    const own = await pin(admin, "playlist", playlistId);
    const shared = await pin(member, "playlist", playlistId);

    await markMissing(backend, libraryId, ["Mix/B.flac"]);

    expect(await entries(admin, own)).toEqual([
      ["A", "fetchable"],
      ["Hidden", "fetchable"],
      ["B", "missing"],
    ]);
    expect(await entries(member, shared)).toEqual([
      ["A", "fetchable"],
      ["B", "missing"],
    ]);
    const sharedPin = (await manifest(member, shared)).pin;

    expect(sharedPin).toMatchObject({ available: true, title: "Road", artHash: COVER });
    // Named for its owner, whom `signUp` names after their email.
    expect(sharedPin.available ? sharedPin.subtitle : null).toMatch(/^admin-/u);
  });
});

describe("a single song's manifest", () => {
  it("keeps the song as missing while its file is gone, and fetchable once it is back", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");
    const pinId = await pin(admin, "track", one._id);

    expect((await manifest(admin, pinId)).pin).toMatchObject({ title: "One", subtitle: "Band" });

    await markMissing(backend, libraryId, ["Kind/One.flac"]);
    expect(await entries(admin, pinId)).toEqual([["One", "missing"]]);

    await scan([file("One", "Kind", 1)]);
    expect(await entries(admin, pinId)).toEqual([["One", "fetchable"]]);
  });
});

describe("a library whose folder isn't claimed", () => {
  it("holds every song of its pins, missing ones too, until a scan claims it again", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1), file("Two", "Kind", 2)]);
    const one = await trackAt("Kind/One.flac");
    const album = await pin(admin, "album", one.albumId);

    const { playlistId } = await admin.music.run("playlists.create", {
      name: "Road",
      trackIds: [TrackId.make(one._id)],
    });

    const playlist = await pin(admin, "playlist", playlistId);

    await markMissing(backend, libraryId, ["Kind/Two.flac"]);
    await backend.mutation(api.media.refuseRoot, { secret: MEDIA_SECRET, libraryId });

    expect(await entries(admin, album)).toEqual([
      ["One", "held"],
      ["Two", "held"],
    ]);
    expect(await entries(admin, playlist)).toEqual([["One", "held"]]);

    await upsertFiles(backend, libraryId, []);
    expect(await entries(admin, album)).toEqual([["One", "fetchable"]]);
  });
});

describe("a pin whose target can't be read", () => {
  it("is unavailable, holds nothing, and doesn't name what it was", async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const member = await signUp(backend, "member");

    await member.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });
    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");
    const album = await pin(member, "album", one.albumId);
    const song = await pin(member, "track", one._id);

    await admin.music.run("libraries.update", {
      libraryId: LibraryId.make(one.libraryId),
      visibility: "private",
    });

    const lost = await Promise.all([manifest(member, album), manifest(member, song)]);

    expect(lost.map((each) => "title" in each.pin)).toEqual([false, false]);
    expect(lost.map((each) => [each.pin.available, each.entries])).toEqual([
      [false, []],
      [false, []],
    ]);

    // A deleted playlist makes its pin unavailable too.
    const { playlistId } = await admin.music.run("playlists.create", { name: "Gone" });
    const playlist = await pin(admin, "playlist", playlistId);

    await admin.music.run("playlists.delete", { playlistId });
    expect((await manifest(admin, playlist)).pin.available).toBe(false);
  });

  it("is someone else's: not found", async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const member = await signUp(backend, "member");

    await scan([file("One", "Kind", 1)]);
    const pinId = await pin(admin, "track", (await trackAt("Kind/One.flac"))._id);

    expect(await failureCode(member.music.read("downloads.manifest", { pinId }))).toBe("not_found");
  });
});

describe("a retag that empties an album", () => {
  it("moves its pins to the album that got most of its songs, keeping the song IDs", async () => {
    const { admin, scan, trackAt } = await setup();

    await scan([file("One", "Old", 1), file("Two", "Old", 2), file("Three", "Old", 3)]);

    const before = await Promise.all(
      ["Old/One.flac", "Old/Two.flac", "Old/Three.flac"].map(trackAt),
    );

    const pinId = await pin(admin, "album", before[0]?.albumId ?? "");

    // The files keep their paths; the tags send two songs to one album and the last to another.
    await scan([
      file("One", "New", 1, { path: "Old/One.flac" }),
      file("Two", "New", 2, { path: "Old/Two.flac" }),
      file("Three", "Other", 3, { path: "Old/Three.flac" }),
    ]);

    const one = await trackAt("Old/One.flac");
    const moved = await manifest(admin, pinId);

    expect(moved.pin).toMatchObject({
      available: true,
      title: "New",
      target: { kind: "album", id: one.albumId },
    });
    expect(moved.entries.map((entry) => entry.track.id)).toEqual([before[0]?._id, before[1]?._id]);
  });

  it("drops the moved pin on a device that already keeps the album the songs went to", async () => {
    const { admin, scan, trackAt } = await setup();

    await scan([file("One", "Old", 1), file("Two", "New", 2)]);
    const [one, two] = await Promise.all([trackAt("Old/One.flac"), trackAt("New/Two.flac")]);

    await pin(admin, "album", one.albumId);
    const kept = await pin(admin, "album", two.albumId);

    await scan([file("One", "New", 1, { path: "Old/One.flac" })]);

    const [listed] = await admin.music.read("downloads.list", { deviceId: PHONE });

    expect(listed?.pins.map((each) => each.id)).toEqual([kept]);
    expect(await entries(admin, kept)).toEqual([
      ["One", "fetchable"],
      ["Two", "fetchable"],
    ]);
  });

  it("leaves a pin unavailable when its album goes with no song moving on", async () => {
    const { admin, backend, libraryId, scan, trackAt } = await setup();

    await scan([file("One", "Old", 1)]);
    const pinId = await pin(admin, "album", (await trackAt("Old/One.flac")).albumId);

    await admin.music.run("libraries.delete", { libraryId: LibraryId.make(libraryId) });
    await drainScheduled(backend);

    expect((await manifest(admin, pinId)).pin.available).toBe(false);
  });
});

describe("downloads.add", () => {
  it("keeps one pin per target and device, whoever adds it again", async () => {
    const { admin, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");
    const first = await pin(admin, "album", one.albumId);

    expect(await pin(admin, "album", one.albumId)).toBe(first);

    const [listed] = await admin.music.read("downloads.list", { deviceId: PHONE });

    expect(listed?.pins.map((each) => each.id)).toEqual([first]);
  });

  it("refuses a device that isn't yours, a target you can't read, and an ID of another kind", async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const member = await signUp(backend, "member");

    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");

    // The admin's phone is not the member's, and nobody has a device that never checked in.
    expect(await failureCode(pin(member, "track", one._id, PHONE))).toBe("not_found");
    expect(await failureCode(pin(admin, "track", one._id, DeviceId.make("nowhere")))).toBe(
      "not_found",
    );

    const secret = await admin.music.run("libraries.create", {
      name: "Secret",
      path: "/music/secret",
      visibility: "private",
    });

    await upsertFiles(backend, secret.libraryId, [{ path: "Hidden.flac" }]);
    await member.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });

    const hidden = await backend.run(async (ctx) =>
      (await ctx.db.query("tracks").collect()).find((track) => track.path === "Hidden.flac"),
    );

    expect(await failureCode(pin(member, "track", hidden?._id ?? "", PHONE))).toBe("not_found");
    expect(await failureCode(pin(member, "album", one._id, PHONE))).toBe("not_found");
  });

  it("takes a device whose row was pruned while it still keeps downloads", async () => {
    const { admin, backend, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1), file("Two", "Kind", 2)]);
    await pin(admin, "track", (await trackAt("Kind/One.flac"))._id);

    await backend.run(async (ctx) => {
      const devices = await ctx.db.query("devices").collect();

      await Promise.all(devices.map((device) => ctx.db.delete(device._id)));
    });

    await pin(admin, "track", (await trackAt("Kind/Two.flac"))._id);

    const [listed] = await admin.music.read("downloads.list", { deviceId: PHONE });

    expect(listed?.device).toBeNull();
    expect(listed?.pins).toHaveLength(2);
  });

  it(`keeps a device to ${DOWNLOAD_PIN_LIMIT} downloads`, async () => {
    const { admin, backend, scan } = await setup();

    const songs = Array.from({ length: DOWNLOAD_PIN_LIMIT + 1 }, (_, index) =>
      file(`Song ${String(index)}`, "Big", index + 1),
    );

    await inOrder(
      Array.from({ length: Math.ceil(songs.length / 100) }, (_, batch) =>
        songs.slice(batch * 100, batch * 100 + 100),
      ),
      scan,
    );

    const tracks = await backend.run(async (ctx) => ctx.db.query("tracks").collect());

    await backend.run(async (ctx) => {
      await Promise.all(
        tracks.slice(0, DOWNLOAD_PIN_LIMIT).map((track) =>
          ctx.db.insert("downloadPins", {
            userId: admin.id,
            deviceId: PHONE,
            target: { kind: "track", id: track._id },
          }),
        ),
      );
    });

    expect(await failureCode(pin(admin, "track", tracks[DOWNLOAD_PIN_LIMIT]?._id ?? ""))).toBe(
      "conflict",
    );
    // Adding one it already keeps still answers with that pin.
    expect(await failureCode(pin(admin, "track", tracks[0]?._id ?? ""))).toBe("succeeded");
    expect(
      await backend.run(async (ctx) => (await ctx.db.query("downloadPins").collect()).length),
    ).toBe(DOWNLOAD_PIN_LIMIT);
  });
});

describe("downloads.remove", () => {
  it("deletes the pin, and removing what isn't kept is fine", async () => {
    const { admin, scan, trackAt } = await setup();

    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");
    const pinId = await pin(admin, "album", one.albumId);
    const remove = { deviceId: PHONE, kind: "album", id: one.albumId } as const;

    await admin.music.run("downloads.remove", remove);
    await admin.music.run("downloads.remove", remove);

    expect(await failureCode(manifest(admin, pinId))).toBe("not_found");
    expect(await admin.music.read("downloads.list", {})).toEqual([]);
  });
});

describe("downloads.list", () => {
  it("groups pins per device, newest first, and lists the device asked for even when it keeps nothing", async () => {
    const { admin, scan, trackAt } = await setup();
    const laptop = DeviceId.make("laptop");

    await admin.music.run("devices.heartbeat", { deviceId: laptop, name: "Mac", kind: "web" });
    await scan([file("One", "Kind", 1), file("Two", "Kind", 2)]);
    const [one, two] = await Promise.all([trackAt("Kind/One.flac"), trackAt("Kind/Two.flac")]);

    const older = await pin(admin, "track", one._id);

    vi.setSystemTime(START + 1000);
    const newer = await pin(admin, "track", two._id);
    const onLaptop = await pin(admin, "album", one.albumId, laptop);

    const all = await admin.music.read("downloads.list", {});

    expect(all.map((device) => [device.deviceId, device.pins.map((each) => each.id)])).toEqual(
      expect.arrayContaining([
        [PHONE, [newer, older]],
        [laptop, [onLaptop]],
      ]),
    );
    expect(all).toHaveLength(2);
    expect(all.find((device) => device.deviceId === laptop)?.device?.name).toBe("Mac");

    const quiet = DeviceId.make("quiet");

    await admin.music.run("devices.heartbeat", { deviceId: quiet, name: "iPad", kind: "phone" });
    expect(await admin.music.read("downloads.list", { deviceId: quiet })).toEqual([
      expect.objectContaining({ deviceId: quiet, pins: [] }),
    ]);
  });

  it(`lists a device's ${DOWNLOAD_PIN_LIMIT} playlist pins within one query's reads`, async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const owner = await signUp(backend, "member");

    // Songs without art, so a list that looked for playlist covers would read every one.
    await scan(
      Array.from({ length: 8 }, (_, index) =>
        file(String(index), "Mix", index + 1, { artHash: undefined }),
      ),
    );

    const songs = await Promise.all(
      Array.from({ length: 8 }, (_, index) => trackAt(`Mix/${String(index)}.flac`)),
    );

    // Someone else's shared playlists cost the most to list: their owner and shares are read too.
    await inOrder(
      Array.from({ length: DOWNLOAD_PIN_LIMIT / 100 }, (_, batch) => batch),
      async () => {
        await backend.run(async (ctx) => {
          await Promise.all(
            Array.from({ length: 100 }, async () => {
              const playlistId = await ctx.db.insert("playlists", {
                ownerId: owner.id,
                name: "Mix",
                trackCount: songs.length,
                durationMs: 0,
                updatedAt: START,
                visibility: "shared",
              });

              await Promise.all(
                songs.map((song, position) =>
                  ctx.db.insert("playlistItems", { playlistId, trackId: song._id, position }),
                ),
              );
              await ctx.db.insert("downloadPins", {
                userId: admin.id,
                deviceId: PHONE,
                target: { kind: "playlist", id: playlistId },
              });
            }),
          );
        });
      },
    );

    const [listed] = await admin.music.read("downloads.list", { deviceId: PHONE });

    expect(listed?.pins).toHaveLength(DOWNLOAD_PIN_LIMIT);
    expect(listed?.pins.every((each) => each.available && each.artHash === null)).toBe(true);
  }, 60_000);
});

describe("pins and the people and devices they belong to", () => {
  it("keep a long-silent device that holds downloads from the prune", async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const tablet = DeviceId.make("tablet");

    await admin.music.run("devices.heartbeat", { deviceId: tablet, name: "iPad", kind: "phone" });
    await scan([file("One", "Kind", 1)]);
    await pin(admin, "track", (await trackAt("Kind/One.flac"))._id);

    vi.setSystemTime(START + DEVICE_RETAINED_MS + 24 * 60 * 60 * 1000);
    await backend.mutation(internal.maintenance.pruneStaleDevices, {});
    await drainScheduled(backend);

    const devices = await backend.run(async (ctx) =>
      (await ctx.db.query("devices").collect()).map((device) => device.deviceId),
    );

    expect(devices).toEqual([PHONE]);
  });

  it("go with the person who made them", async () => {
    const { admin, backend, scan, trackAt } = await setup();
    const member = await signUp(backend, "member");

    await member.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });
    await scan([file("One", "Kind", 1)]);
    const one = await trackAt("Kind/One.flac");

    await pin(member, "track", one._id);
    const kept = await pin(admin, "track", one._id);

    await admin.music.run("people.remove", { userId: UserId.make(member.id) });
    await drainScheduled(backend);

    const left = await backend.run(async (ctx) =>
      (await ctx.db.query("downloadPins").collect()).map((each) => each._id),
    );

    expect(left).toEqual([kept]);
  });
});
