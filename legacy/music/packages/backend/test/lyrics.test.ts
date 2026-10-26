/**
 * The lyrics the media service stores for each song, and `lyrics.get` through the real
 * dispatcher: what it answers, who may read it, and how stored lyrics follow scans, moves, and
 * removed libraries.
 */
import { DeviceId, LibraryId, type TrackId } from "@music/commands/ids";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { StoredLyricSet } from "../convex/lib/lyrics";
import {
  MEDIA_SECRET,
  NO_LYRICS,
  allTracks,
  drainScheduled,
  makeBackend,
  markMissing,
  signUp,
  upsertFiles,
} from "./backend";
import type { Backend, SeedFile, User } from "./backend";
import { failureCode } from "./harness";

const DEVICE = DeviceId.make("host-laptop");

const SYNCED: StoredLyricSet = {
  kind: "main",
  lang: null,
  origin: { _tag: "Sidecar", fileName: "synced.lrc", format: "lrc" },
  body: {
    _tag: "Synced",
    lines: [
      { text: "First line", startMs: 1000, endMs: null, words: null, voice: null },
      {
        text: "Second line",
        startMs: 2500,
        endMs: 4000,
        words: [
          { text: "Second ", startMs: 2500, endMs: 3000 },
          { text: "line", startMs: 3000, endMs: 4000 },
        ],
        voice: "v1",
      },
    ],
  },
};

const TRANSLATION: StoredLyricSet = {
  kind: "translation",
  lang: "de",
  origin: { _tag: "Sidecar", fileName: "synced.de.lrc", format: "lrc" },
  body: { _tag: "Plain", text: "Erste Zeile" },
};

const PLAIN: StoredLyricSet = {
  kind: "main",
  lang: "en",
  origin: { _tag: "Embedded", tag: "mp4:lyr" },
  body: { _tag: "Plain", text: "Just words\nMore words" },
};

/** Creates a library as `admin` holding `files`, each titled with its path. */
const libraryWith = async (
  backend: Backend,
  admin: User,
  name: string,
  visibility: "shared" | "private",
  files: ReadonlyArray<SeedFile>,
): Promise<Id<"libraries">> => {
  const { libraryId } = await admin.music.run("libraries.create", {
    name,
    path: `/music/${name}`,
    visibility,
  });

  await upsertFiles(backend, libraryId, files);
  const id = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", libraryId));

  if (id === null) throw new Error(`${libraryId} is not a library`);

  return id;
};

/** The ID of the track titled `title` among those `user` can read. */
const trackTitled = async (user: User, title: string): Promise<TrackId> => {
  const track = (await allTracks(user)).find((candidate) => candidate.title === title);

  if (track === undefined) throw new Error(`No track titled ${title}`);

  return track.id;
};

/** A file as `media:upsertTracks` and `media:moveTracks` take it, as `upsertFiles` seeds them. */
const scanned = (path: string, lyrics: Array<StoredLyricSet>) => ({
  path,
  size: 1000,
  mtimeMs: 1_700_000_000_000,
  title: "synced.flac",
  artist: "Artist",
  album: "Album",
  durationMs: 180_000,
  codec: "flac",
  lossless: true,
  artHash: "0".repeat(64),
  ...NO_LYRICS,
  lyricsReader: 1,
  lyrics,
});

const lyricsOf = (user: User, trackId: TrackId) => user.music.read("lyrics.get", { trackId });

const setup = async () => {
  const backend = makeBackend();
  const owner = await signUp(backend, "owner");
  const member = await signUp(backend, "member");

  const libraryId = await libraryWith(backend, owner, "Songs", "shared", [
    { path: "synced.flac", lyrics: [SYNCED, TRANSLATION] },
    { path: "plain.flac", lyrics: [PLAIN] },
    { path: "none.flac" },
  ]);

  const rows = () => backend.run(async (ctx) => ctx.db.query("localLyrics").collect());

  return { backend, owner, member, libraryId, rows };
};

describe("lyrics.get", () => {
  it("answers a song's synced lyrics with the rest of its sets, its plain lyrics, or none", async () => {
    const { member } = await setup();

    expect(await lyricsOf(member, await trackTitled(member, "synced.flac"))).toEqual({
      _tag: "Synced",
      source: "file",
      main: SYNCED,
      extras: [TRANSLATION],
    });
    expect(await lyricsOf(member, await trackTitled(member, "plain.flac"))).toEqual({
      _tag: "Plain",
      source: "file",
      main: PLAIN,
      extras: [],
    });
    expect(await lyricsOf(member, await trackTitled(member, "none.flac"))).toEqual({
      _tag: "None",
    });
  });

  it("finds no song in a library the person can't read, as other song reads do", async () => {
    const { backend, owner, member } = await setup();

    await libraryWith(backend, owner, "Mine", "private", [
      { path: "private.flac", lyrics: [PLAIN] },
    ]);
    const hidden = await trackTitled(owner, "private.flac");

    expect(await failureCode(member.music.read("lyrics.get", { trackId: hidden }))).toBe(
      "not_found",
    );
    expect(
      await failureCode(member.music.read("stream.url", { trackId: hidden, profile: "original" })),
    ).toBe("not_found");
    expect(await failureCode(owner.music.read("lyrics.get", { trackId: hidden }))).toBe(
      "succeeded",
    );
  });

  it("lets people in a Jam read the lyrics of the songs it plays, and only while in it", async () => {
    const { backend, owner, member } = await setup();

    await libraryWith(backend, owner, "Mine", "private", [
      { path: "playing.flac", lyrics: [SYNCED] },
      { path: "unplayed.flac", lyrics: [PLAIN] },
    ]);
    const playing = await trackTitled(owner, "playing.flac");
    const unplayed = await trackTitled(owner, "unplayed.flac");
    const read = (trackId: TrackId) => failureCode(member.music.read("lyrics.get", { trackId }));

    await owner.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
    await owner.music.run("queue.autoplay", { on: false });
    await owner.music.run("playback.play", { trackIds: [playing], deviceId: DEVICE });

    expect(await read(playing)).toBe("not_found");

    const { code } = await owner.music.run("jam.start", {});

    await member.music.run("jam.join", { code });
    expect(await read(playing)).toBe("succeeded");
    expect(await read(unplayed)).toBe("not_found");

    await member.music.run("jam.leave", {});
    expect(await read(playing)).toBe("not_found");
  });
});

describe("stored lyrics", () => {
  it("replace a song's lyrics when a scan reads them again, leaving the song as it was", async () => {
    const { backend, member, libraryId, rows } = await setup();
    const trackId = await trackTitled(member, "synced.flac");

    const trackDoc = () =>
      backend.run(async (ctx) => {
        const id = ctx.db.normalizeId("tracks", trackId);

        return id === null ? null : ctx.db.get(id);
      });

    const before = await trackDoc();

    const save = (lyrics: Array<StoredLyricSet>) =>
      backend.mutation(api.media.saveLocalLyrics, {
        secret: MEDIA_SECRET,
        libraryId,
        tracks: [
          { path: "synced.flac", lyricsFiles: "synced.txt:12:3000", lyricsReader: 1, lyrics },
        ],
      });

    // A retried batch writes the same lyrics again.
    await save([PLAIN]);
    await save([PLAIN]);

    expect(await trackDoc()).toEqual({
      ...before,
      lyricsFiles: "synced.txt:12:3000",
      lyricsReader: 1,
      lyricsBytes: new TextEncoder().encode(JSON.stringify([PLAIN])).length,
      lyricsSynced: false,
    });
    expect(await lyricsOf(member, trackId)).toMatchObject({ _tag: "Plain", main: PLAIN });
    expect((await rows()).length).toBe(2);

    const { files } = await backend.query(api.media.fingerprints, {
      secret: MEDIA_SECRET,
      libraryId,
      cursor: null,
    });

    expect(files.find((file) => file.path === "synced.flac")).toMatchObject({
      lyricsFiles: "synced.txt:12:3000",
      lyricsReader: 1,
    });

    await save([]);
    expect(await lyricsOf(member, trackId)).toEqual({ _tag: "None" });
    expect((await rows()).length).toBe(1);
  });

  it("refuses lyric sets that break the lyrics schema", async () => {
    const { backend, libraryId } = await setup();

    const broken: StoredLyricSet = {
      ...PLAIN,
      lang: "not a language",
      body: { _tag: "Plain", text: "" },
    };

    expect(
      await failureCode(
        backend.mutation(api.media.saveLocalLyrics, {
          secret: MEDIA_SECRET,
          libraryId,
          tracks: [{ path: "plain.flac", ...NO_LYRICS, lyrics: [broken] }],
        }),
      ),
    ).toBe("invalid_args");
  });

  it("stay while a song is missing and follow it when it moves", async () => {
    const { backend, owner, libraryId } = await setup();
    const trackId = await trackTitled(owner, "synced.flac");

    await markMissing(backend, libraryId, ["synced.flac"]);
    expect(await lyricsOf(owner, trackId)).toMatchObject({ _tag: "Synced", main: SYNCED });

    const { moved } = await backend.mutation(api.media.moveTracks, {
      secret: MEDIA_SECRET,
      libraryId,
      moves: [{ from: "synced.flac", track: scanned("Moved/synced.flac", [PLAIN]) }],
    });

    expect(moved).toBe(1);
    expect(await trackTitled(owner, "synced.flac")).toBe(trackId);
    expect(await lyricsOf(owner, trackId)).toMatchObject({ _tag: "Plain", main: PLAIN });
  });

  it("never answer a stored row that no longer reads as lyrics, and show none instead", async () => {
    const { backend, member } = await setup();
    const trackId = await trackTitled(member, "plain.flac");

    await backend.run(async (ctx) => {
      const id = ctx.db.normalizeId("tracks", trackId);

      if (id === null) throw new Error(`${trackId} is not a track`);

      const row = await ctx.db
        .query("localLyrics")
        .withIndex("by_track", (q) => q.eq("trackId", id))
        .unique();

      if (row === null) throw new Error(`${trackId} has no lyrics`);
      await ctx.db.patch(row._id, { sets: [{ ...PLAIN, lang: "not a language" }] });
    });

    expect(await lyricsOf(member, trackId)).toEqual({ _tag: "None" });
  });

  it("refuse lyric sets from LRCLIB as a song's own", async () => {
    const { backend, libraryId } = await setup();

    // Called by name, as a client that does not share the backend's types would.
    const saveLocalLyrics = makeFunctionReference<
      "mutation",
      { secret: string; libraryId: string; tracks: ReadonlyArray<unknown> }
    >("media:saveLocalLyrics");

    const lrclib = { ...PLAIN, origin: { _tag: "Lrclib", recordId: 3 } };

    await expect(
      backend.mutation(saveLocalLyrics, {
        secret: MEDIA_SECRET,
        libraryId,
        tracks: [{ path: "plain.flac", ...NO_LYRICS, lyrics: [lrclib] }],
      }),
    ).rejects.toThrow(/Validator error/u);
  });

  it("go with the songs of a removed library", async () => {
    const { backend, owner, libraryId, rows } = await setup();

    await libraryWith(backend, owner, "Other", "shared", [{ path: "kept.flac", lyrics: [PLAIN] }]);
    const kept = await trackTitled(owner, "kept.flac");

    expect((await rows()).length).toBe(3);
    await owner.music.run("libraries.delete", { libraryId: LibraryId.make(libraryId) });
    await drainScheduled(backend);

    expect((await rows()).map((row) => row.trackId)).toEqual([kept]);
  });
});

/** About 600 KB of lyrics, as many large lyric files beside one song can hold. */
const large = (index: number): StoredLyricSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Embedded", tag: "other" },
  body: { _tag: "Plain", text: `${index} ${"la ".repeat(200_000)}` },
});

/** Runs `run` for each of `items`, one after another. */
const eachInOrder = <A, B>(items: ReadonlyArray<A>, run: (item: A) => Promise<B>): Promise<void> =>
  items.reduce<Promise<void>>(async (previous, item) => {
    await previous;
    await run(item);
  }, Promise.resolve());

/** A library of 30 songs, each with about 600 KB of lyrics, seeded three songs at a time. */
const crowdedLibrary = async () => {
  const backend = makeBackend();
  const owner = await signUp(backend, "owner");
  const paths = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")}.flac`);

  const libraryId = await libraryWith(backend, owner, "Crowded", "shared", []);
  const starts = Array.from({ length: paths.length / 3 }, (_, batch) => batch * 3);

  // Three songs a write: their lyrics are about as much as one write may send.
  await eachInOrder(starts, (start) =>
    upsertFiles(
      backend,
      libraryId,
      paths
        .slice(start, start + 3)
        .map((path, offset) => ({ path, lyrics: [large(start + offset)] })),
    ),
  );

  const rows = () => backend.run(async (ctx) => ctx.db.query("localLyrics").collect());

  return { backend, owner, libraryId, paths, rows };
};

describe("large stored lyrics", () => {
  it("are sized in the fingerprints, so a scan can clear them in writes Convex can run", async () => {
    const { backend, libraryId, paths, rows } = await crowdedLibrary();

    const { files } = await backend.query(api.media.fingerprints, {
      secret: MEDIA_SECRET,
      libraryId,
      cursor: null,
    });

    expect(files.map((file) => [file.path, file.lyricsBytes])).toEqual(
      paths.map((path, index) => [
        path,
        new TextEncoder().encode(JSON.stringify([large(index)])).length,
      ]),
    );

    // As a scan sends them: writes that replace at most 2 MiB of stored lyrics each.
    const batches: Array<Array<string>> = [];
    let bytes = Infinity;

    for (const file of files) {
      const size = file.lyricsBytes ?? 0;

      if (bytes + size > 2 * 1024 * 1024) {
        batches.push([]);
        bytes = 0;
      }

      batches.at(-1)?.push(file.path);
      bytes += size;
    }

    expect(batches.flat().toSorted()).toEqual([...paths]);

    await eachInOrder(batches, (batch) =>
      backend.mutation(api.media.saveLocalLyrics, {
        secret: MEDIA_SECRET,
        libraryId,
        tracks: batch.map((path) => ({ path, lyricsFiles: "", lyricsReader: 1, lyrics: [] })),
      }),
    );

    expect(await rows()).toEqual([]);
  });

  it("go with the songs of a removed library, however large", async () => {
    const { backend, owner, libraryId, rows } = await crowdedLibrary();

    await owner.music.run("libraries.delete", { libraryId: LibraryId.make(libraryId) });
    await drainScheduled(backend);

    expect(await rows()).toEqual([]);
    expect(await backend.run(async (ctx) => ctx.db.query("tracks").collect())).toEqual([]);
  });
});
