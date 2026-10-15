/**
 * The catalog's counters, playlists, and deleting a library, through the real dispatcher and the
 * media service functions, against convex-test.
 */
import { DeviceId } from "@music/commands/ids";
import type { CommandArgsEncoded, CommandResult, MutationName } from "@music/commands/registry";
import { decodeCommandResult } from "@music/sdk/client";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";

import {
  allTracks,
  drainScheduled,
  makeBackend,
  markMissing,
  seedLibrary,
  signUp,
  trackIds,
  upsertFiles,
} from "./backend";
import type { User } from "./backend";
import { failure, failureCode } from "./harness";

const DEVICE = DeviceId.make("test-device");

describe("catalog counters", () => {
  it("counts songs, albums, and artists as files come and go", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Rock", count: 3 });

    await upsertFiles(backend, libraryId, [
      { path: "Other/1.flac", title: "Other 1", album: "Other", artist: "Someone" },
    ]);

    expect((await admin.music.read("library.home", {})).stats).toEqual({
      tracks: 4,
      albums: 2,
      artists: 2,
      durationMs: 4 * 180_000,
    });

    await markMissing(backend, libraryId, ["Other/1.flac", "Rock/0001.flac"]);

    expect((await admin.music.read("library.home", {})).stats).toEqual({
      tracks: 2,
      albums: 1,
      artists: 1,
      durationMs: 2 * 180_000,
    });

    const albums = await admin.music.read("albums.list", {});

    expect(albums.items.map((album) => [album.title, album.trackCount])).toEqual([
      ["Rock Album", 2],
    ]);

    // The file coming back puts it back.
    await upsertFiles(backend, libraryId, [
      { path: "Other/1.flac", title: "Other 1", album: "Other", artist: "Someone" },
    ]);

    expect((await admin.music.read("library.home", {})).stats.albums).toBe(2);
  });
});

describe("playlists", () => {
  it("keeps the song count and length as songs are added and removed", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Rock", count: 3 });
    const rock = trackIds(await allTracks(admin), "Rock");

    const { playlistId } = await admin.music.run("playlists.create", {
      name: "Mix",
      trackIds: rock.slice(0, 2),
    });

    await admin.music.run("playlists.add", { playlistId, trackIds: rock.slice(2) });
    const full = await admin.music.read("playlists.get", { playlistId });

    expect(full.playlist.trackCount).toBe(3);
    expect(full.playlist.durationMs).toBe(3 * 180_000);
    expect(full.items.map((item) => item.track?.id)).toEqual(rock);

    const [first] = full.items;

    if (first === undefined) throw new Error("Playlist lost its first song");
    await admin.music.run("playlists.remove", { playlistId, itemId: first.itemId });
    const after = await admin.music.read("playlists.get", { playlistId });

    expect(after.playlist.trackCount).toBe(2);
    expect(after.playlist.durationMs).toBe(2 * 180_000);
  });

  it("shows a song whose file is gone as unavailable, and lets you remove it", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Rock", count: 2 });
    const rock = trackIds(await allTracks(admin), "Rock");

    const { playlistId } = await admin.music.run("playlists.create", {
      name: "Mix",
      trackIds: [...rock],
    });

    await markMissing(backend, libraryId, ["Rock/0001.flac"]);
    const detail = await admin.music.read("playlists.get", { playlistId });

    expect(detail.items.map((item) => [item.track?.id, item.available])).toEqual([
      [rock[0], false],
      [rock[1], true],
    ]);

    const [gone] = detail.items;

    if (gone === undefined) throw new Error("The missing song was hidden");
    await admin.music.run("playlists.remove", { playlistId, itemId: gone.itemId });
    const after = await admin.music.read("playlists.get", { playlistId });

    expect(after.items.map((item) => item.track?.id)).toEqual([rock[1]]);
    expect(after.playlist.trackCount).toBe(1);
  });

  it("takes covers only from songs the viewer can still read", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const member = await signUp(backend, "member");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Rock", count: 1 });
    const [song] = trackIds(await allTracks(member), "Rock");

    if (song === undefined) throw new Error("Seed missing");

    const { playlistId } = await member.music.run("playlists.create", {
      name: "Mine",
      trackIds: [song],
    });

    expect(
      (await member.music.read("playlists.get", { playlistId })).playlist.artUrls,
    ).toHaveLength(1);

    // The owner makes the library private: the member keeps the playlist, and the song stays in
    // it as an unavailable row, without its cover.
    await backend.run(async (ctx) => {
      const id = ctx.db.normalizeId("libraries", libraryId);

      if (id !== null) await ctx.db.patch(id, { visibility: "private" });
    });

    const [listed] = await member.music.read("playlists.list", {});

    expect(listed?.artUrls).toEqual([]);
    expect(
      (await member.music.read("playlists.get", { playlistId })).items.map((item) => [
        item.available,
        item.reason,
        item.track,
      ]),
    ).toEqual([[false, "no_access", null]]);
  });
});

describe("deleting a library", () => {
  it("removes its catalog, playlist entries, likes, plays, and queue entries", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const member = await signUp(backend, "member");
    const rockLibrary = await seedLibrary(backend, admin, { name: "Rock", count: 3 });
    await seedLibrary(backend, admin, { name: "Jazz", count: 2 });
    const tracks = await allTracks(member);
    const rock = trackIds(tracks, "Rock");
    const jazz = trackIds(tracks, "Jazz");

    const { playlistId } = await member.music.run("playlists.create", {
      name: "Both",
      trackIds: [...rock, ...jazz, ...rock],
    });

    await Promise.all(
      [...rock, ...jazz].map((trackId) => member.music.run("likes.set", { trackId, liked: true })),
    );

    await member.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Phone", kind: "web" });
    await member.music.run("playback.play", { trackIds: [...rock, ...jazz], deviceId: DEVICE });
    await member.music.run("playback.report", {
      deviceId: DEVICE,
      index: 0,
      positionMs: 1000,
      playing: true,
    });

    await admin.music.run("libraries.delete", { libraryId: rockLibrary.libraryId });
    await drainScheduled(backend);

    // The song playing was deleted, so the next one starts from the top.
    const now = await member.music.read("playback.state", {});

    expect(now.queue[now.index]?.id).toBe(jazz[0]);
    expect(now.positionMs).toBe(0);

    const playlist = await member.music.read("playlists.get", { playlistId });

    expect(playlist.items.map((item) => item.track?.id)).toEqual(jazz);
    expect(playlist.playlist.trackCount).toBe(2);
    expect(playlist.playlist.durationMs).toBe(2 * 180_000);

    const leftovers = await backend.run(async (ctx) => ({
      tracks: (await ctx.db.query("tracks").collect()).length,
      albums: (await ctx.db.query("albums").collect()).length,
      artists: (await ctx.db.query("artists").collect()).length,
      playlistItems: (await ctx.db.query("playlistItems").collect()).length,
      likes: (await ctx.db.query("likes").collect()).length,
      history: (await ctx.db.query("history").collect()).length,
      queues: (await ctx.db.query("playbackQueues").collect()).map((row) =>
        (row.items ?? []).map((item) => item.trackId),
      ),
    }));

    expect(leftovers).toEqual({
      tracks: 2,
      albums: 1,
      artists: 1,
      playlistItems: 2,
      likes: 2,
      history: 0,
      queues: [jazz],
    });
  });

  it("stops playback when deleting a library empties the queue", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Only", count: 2 });
    const only = trackIds(await allTracks(admin), "Only");

    await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Phone", kind: "web" });
    await admin.music.run("playback.play", { trackIds: [...only], deviceId: DEVICE });
    await admin.music.run("libraries.delete", { libraryId });
    await drainScheduled(backend);

    const state = await admin.music.read("playback.state", {});

    expect(state.queue).toEqual([]);
    expect(state.playing).toBe(false);
  });

  it(
    "deletes a large catalog in batches that stay inside Convex's limits",
    { timeout: 60_000 },
    async () => {
      const backend = makeBackend({ documentsWritten: 1000 });
      const admin = await signUp(backend, "admin");

      // One song per album, so the library holds as many albums as songs.
      const { libraryId } = await admin.music.run("libraries.create", {
        name: "Singles",
        path: "/music/singles",
      });

      const batches = Array.from({ length: 12 }, (_, batch) =>
        Array.from({ length: 100 }, (__, index) => {
          const number = batch * 100 + index;

          return { path: `${number}.flac`, title: `Single ${number}`, album: `Single ${number}` };
        }),
      );

      await batches.reduce(async (previous, files) => {
        await previous;
        await upsertFiles(backend, libraryId, files);
      }, Promise.resolve());

      await admin.music.run("libraries.delete", { libraryId });
      await drainScheduled(backend);

      const left = await backend.run(async (ctx) => ({
        tracks: (await ctx.db.query("tracks").collect()).length,
        albums: (await ctx.db.query("albums").collect()).length,
        artists: (await ctx.db.query("artists").collect()).length,
      }));

      expect(left).toEqual({ tracks: 0, albums: 0, artists: 0 });
    },
  );
});

/** Runs a command straight through the dispatcher, past the SDK, which cleans text as it encodes. */
const raw = async <Name extends MutationName>(
  user: User,
  name: Name,
  args: CommandArgsEncoded<Name>,
): Promise<CommandResult<Name>> =>
  decodeCommandResult(name, await user.as.mutation(api.commands.run, { name, args }));

describe("typed names and descriptions", () => {
  it("lose their control characters on every path that saves one", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    const { playlistId } = await raw(owner, "playlists.create", {
      name: "\u001b[2JRoad\u0000 trip",
      description: "Line one\nline two\u009b",
    });

    await raw(owner, "libraries.create", { name: "Vinyl\u0007 rips", path: "/music/vinyl" });
    await raw(owner, "account.rename", { name: "\u001b]0;Owner\u0007" });

    const { playlist } = await owner.music.read("playlists.get", { playlistId });
    const [library] = await owner.music.read("libraries.list", {});

    expect([playlist.name, playlist.description]).toEqual(["[2JRoad trip", "Line one line two"]);
    expect(library?.name).toBe("Vinyl rips");
    expect((await owner.music.read("account.me", {})).name).toBe("]0;Owner");

    await raw(owner, "playlists.update", { playlistId, description: "\u0085\u001b\t" });

    expect(
      (await owner.music.read("playlists.get", { playlistId })).playlist.description,
    ).toBeNull();
  });

  it("refuse a library folder path with a control character, without repeating it", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    // Alone, and with the other checks failing too: no leading slash, or a trailing space.
    const outcomes = await Promise.all(
      ["/music/\u001b]0;pwned\u0007", "music/\u001b]0;pwned\u0007", "/music/\u001b]0;pwned "].map(
        (path) => failure(raw(owner, "libraries.create", { name: "Vinyl", path })),
      ),
    );

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ code: "invalid_args" });
      expect(JSON.stringify(outcome)).not.toContain("pwned");
    }

    expect(await owner.music.read("libraries.list", {})).toEqual([]);
  });

  it("store an empty description as none, whether made or changed", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    const { playlistId } = await raw(owner, "playlists.create", {
      name: "Quiet",
      description: "\t\u0007 ",
    });

    expect(
      await backend.run(async (ctx) => {
        const id = ctx.db.normalizeId("playlists", playlistId);

        return id === null ? null : ((await ctx.db.get(id))?.description ?? "absent");
      }),
    ).toBe("absent");
  });

  it("refuse a name that is only control characters", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    expect(await failureCode(raw(owner, "playlists.create", { name: "\u001b\u0007" }))).toBe(
      "invalid_args",
    );
  });
});
