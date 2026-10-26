/**
 * What scan batches cost and write: the catalog writer's reads per batch, artwork that falls out
 * of use, and the library counters' own row, against convex-test.
 */
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { catalogBatch, type ScannedTrack } from "../convex/lib/catalog";
import { inOrder } from "../convex/lib/sequence";
import {
  MEDIA_SECRET,
  NO_LYRICS,
  drainScheduled,
  makeBackend,
  seedLibrary,
  signUp,
} from "./backend";
import type { Backend } from "./backend";

const COVER = "c".repeat(64);

const OTHER_COVER = "d".repeat(64);

/** A scanned file of the album `Big` by `Band`, with the given art. */
const song = (index: number, artHash?: string): ScannedTrack => ({
  path: `Band/Big/${String(index).padStart(4, "0")}.flac`,
  size: 1000 + index,
  mtimeMs: 1_700_000_000_000,
  title: `Song ${index}`,
  artist: "Band",
  album: "Big",
  trackNumber: index,
  durationMs: 180_000,
  codec: "flac",
  lossless: true,
  artHash,
  ...NO_LYRICS,
});

const libraryOf = async (backend: Backend, id: string): Promise<Id<"libraries">> => {
  const library = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", id));

  if (library === null) throw new Error(`${id} is not a library`);

  return library;
};

/** Writes `tracks` through one catalog batch and returns what that cost. */
const writeBatch = (backend: Backend, libraryId: Id<"libraries">, tracks: Array<ScannedTrack>) =>
  backend.mutation(async (ctx: MutationCtx) => {
    const before = await ctx.meta.getTransactionMetrics();
    const batch = catalogBatch(ctx, libraryId);

    await inOrder(tracks, (track) => batch.upsert(track));
    const released = await batch.finish();
    const after = await ctx.meta.getTransactionMetrics();

    return { read: after.documentsRead.used - before.documentsRead.used, released };
  });

const art = (backend: Backend) =>
  backend.run(async (ctx) => ({
    albums: (await ctx.db.query("albums").collect()).map((album) => album.artHash ?? null),
    artists: (await ctx.db.query("artists").collect()).map((artist) => artist.artHash ?? null),
  }));

describe("a scan batch", () => {
  it("reads each album and artist once, however many of its songs the batch holds", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Big", path: "/big" });
    const libraryId = await libraryOf(backend, created.libraryId);
    const songs = Array.from({ length: 100 }, (_, index) => song(index + 1, COVER));

    const first = await writeBatch(backend, libraryId, songs);

    // The new artist and album, each read back after its insert, then read and patched once for
    // its counts, and the library's counters row, read and patched: not a read per song.
    expect(first.read).toBe(8);

    // Rescanning the same files changes no count, so no album, artist, or counter is touched.
    const again = await writeBatch(backend, libraryId, songs);

    expect(again.read).toBe(100 + 2 + 100);
    expect((await admin.music.read("library.home", {})).stats).toEqual({
      tracks: 100,
      albums: 1,
      artists: 1,
      durationMs: 100 * 180_000,
    });
  });

  it("finds other art for an album in a few reads, however many songs it has", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Big", path: "/big" });
    const libraryId = await libraryOf(backend, created.libraryId);

    // One song has a cover, which the album and artist take; 300 others have none.
    await writeBatch(backend, libraryId, [song(0, COVER)]);

    await inOrder([1, 101, 201], async (start) => {
      await writeBatch(
        backend,
        libraryId,
        Array.from({ length: 100 }, (_, index) => song(start + index)),
      );
    });

    expect(await art(backend)).toEqual({ albums: [COVER], artists: [COVER] });

    // The song loses its cover: no other song has art, which takes a look, not 300 reads.
    const lost = await writeBatch(backend, libraryId, [song(0)]);

    expect(lost.read).toBeLessThan(12);
    expect(lost.released).toEqual([COVER]);
    expect(await art(backend)).toEqual({ albums: [null], artists: [null] });
  });

  it("names the art it stopped using, and artInUse tells which is still used", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Big", path: "/big" });
    const libraryId = await libraryOf(backend, created.libraryId);

    await writeBatch(backend, libraryId, [song(1, COVER), song(2, COVER)]);

    // One song gets its own picture: the album keeps the cover the other song still has.
    const changed = await writeBatch(backend, libraryId, [song(1, OTHER_COVER)]);

    expect(changed.released).toEqual([COVER]);

    const check = (hashes: Array<string>) =>
      backend.query(api.media.artInUse, { secret: MEDIA_SECRET, hashes });

    expect(await check([COVER, OTHER_COVER, "e".repeat(64)])).toEqual({
      inUse: [COVER, OTHER_COVER],
    });

    // The last song with the old cover gets the new one too, and the folder cover changed.
    await backend.mutation(api.media.upsertTracks, {
      secret: MEDIA_SECRET,
      libraryId,
      tracks: [{ ...song(2, OTHER_COVER), folderArt: "Band/Big/cover.jpg:2:2" }],
    });

    expect(await check([COVER])).toEqual({ inUse: [] });
    await expect(check(Array.from({ length: 201 }, () => COVER))).rejects.toThrow(/at most 200/u);
  });
});

describe("an album a retag empties", () => {
  it("is deleted with its batch, and only then its art is released", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Big", path: "/big" });
    const libraryId = await libraryOf(backend, created.libraryId);

    await writeBatch(backend, libraryId, [song(1, COVER)]);

    // The album's only song is retagged into another album by another artist, with new art.
    const moved = await writeBatch(backend, libraryId, [
      { ...song(1, OTHER_COVER), album: "Other", artist: "Someone" },
    ]);

    expect(moved.released).toEqual([COVER]);
    expect(await art(backend)).toEqual({ albums: [OTHER_COVER], artists: [OTHER_COVER] });
    expect(
      await backend.query(api.media.artInUse, { secret: MEDIA_SECRET, hashes: [COVER] }),
    ).toEqual({ inUse: [] });
  });
});

describe("library counters", () => {
  it("live in their own row, so a scan batch never rewrites the library", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Rock", count: 3 });
    const id = await libraryOf(backend, libraryId);

    const rows = await backend.run(async (ctx) => ({
      library: await ctx.db.get(id),
      stats: await ctx.db.query("libraryStats").collect(),
    }));

    expect(rows.library).not.toHaveProperty("trackCount");
    expect(rows.stats).toEqual([
      expect.objectContaining({ libraryId: id, trackCount: 3, albumCount: 1, artistCount: 1 }),
    ]);

    // The library's row is as `libraries.create` wrote it: queries reading it never re-ran.
    expect(rows.library?._creationTime).toBeDefined();
    expect((await admin.music.read("libraries.list", {}))[0]?.trackCount).toBe(3);

    await admin.music.run("libraries.delete", { libraryId });

    expect(await backend.run(async (ctx) => ctx.db.query("libraryStats").collect())).toEqual([]);
  });

  it("reads counters an older version kept on the library, and moves them on the next scan", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const libraryId = await legacyLibrary(backend, admin.id);

    expect((await admin.music.read("library.home", {})).stats).toEqual({
      tracks: 7,
      albums: 2,
      artists: 1,
      durationMs: 7_000,
    });

    await writeBatch(backend, libraryId, [song(1, COVER)]);
    const rows = await counters(backend, libraryId);

    expect(rows.library).toEqual({ trackCount: undefined, albumCount: undefined });
    expect(rows.stats).toEqual([{ trackCount: 8, albumCount: 3, artistCount: 2 }]);
  });

  it("are moved by the splitLibraryStats migration", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const libraryId = await legacyLibrary(backend, admin.id);

    await backend.mutation(internal.migrations.run, {});
    await drainScheduled(backend);
    const rows = await counters(backend, libraryId);

    expect(rows.library).toEqual({ trackCount: undefined, albumCount: undefined });
    expect(rows.stats).toEqual([{ trackCount: 7, albumCount: 2, artistCount: 1 }]);
    expect((await admin.music.read("library.home", {})).stats.tracks).toBe(7);
  });
});

/** A library with its counters on its own row, as versions before `libraryStats` stored it. */
const legacyLibrary = (backend: Backend, ownerId: Id<"users">) =>
  backend.run(async (ctx) =>
    ctx.db.insert("libraries", {
      name: "Old",
      path: "/old",
      visibility: "shared",
      ownerId,
      trackCount: 7,
      albumCount: 2,
      artistCount: 1,
      durationMs: 7_000,
    }),
  );

const counters = (backend: Backend, libraryId: Id<"libraries">) =>
  backend.run(async (ctx) => {
    const library = await ctx.db.get(libraryId);
    const stats = await ctx.db.query("libraryStats").collect();

    return {
      library: { trackCount: library?.trackCount, albumCount: library?.albumCount },
      stats: stats.map((row) => ({
        trackCount: row.trackCount,
        albumCount: row.albumCount,
        artistCount: row.artistCount,
      })),
    };
  });
