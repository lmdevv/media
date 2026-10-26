/**
 * `downloads.lyrics` through the real dispatcher: the lyrics a device keeps with its downloads,
 * sent only when their revision moved, as songs' own lyrics and LRCLIB's answers change, to
 * people who can read the songs, and in pages that stay inside Convex's read limits.
 */
import { DeviceId, type TrackId } from "@music/commands/ids";
import { LyricsChange } from "@music/commands/lyrics";
import type { HeldLyrics, LyricsRevision, TrackLyrics } from "@music/commands/lyrics";
import type { Infer } from "convex/values";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { StoredLyricSet } from "../convex/lib/lyrics";
import type { lrclibLyricSet } from "../convex/schema";
import {
  MEDIA_SECRET,
  NO_LYRICS,
  allTracks,
  drainScheduled,
  makeBackend,
  signUp,
  upsertFiles,
} from "./backend";
import type { Backend, SeedFile, User } from "./backend";

const PHONE = DeviceId.make("phone");

const SYNCED: StoredLyricSet = {
  kind: "main",
  lang: null,
  origin: { _tag: "Sidecar", fileName: "synced.lrc", format: "lrc" },
  body: {
    _tag: "Synced",
    lines: [{ text: "Own line", startMs: 1000, endMs: null, words: null, voice: null }],
  },
};

const PLAIN: StoredLyricSet = {
  kind: "main",
  lang: null,
  origin: { _tag: "Embedded", tag: "id3:USLT" },
  body: { _tag: "Plain", text: "Own words" },
};

const LRCLIB: Infer<typeof lrclibLyricSet> = {
  kind: "main",
  lang: null,
  origin: { _tag: "Lrclib", recordId: 7 },
  body: {
    _tag: "Synced",
    lines: [{ text: "LRCLIB line", startMs: 500, endMs: null, words: null, voice: null }],
  },
};

const SONGS: ReadonlyArray<SeedFile> = [
  { path: "synced.flac", title: "Synced", lyrics: [SYNCED] },
  { path: "plain.flac", title: "Plain", lyrics: [PLAIN] },
  { path: "none.flac", title: "None" },
];

/** Creates a library as `owner` holding `files`; returns its ID. */
const libraryOf = async (
  backend: Backend,
  owner: User,
  name: string,
  visibility: "shared" | "private",
  files: ReadonlyArray<SeedFile>,
): Promise<Id<"libraries">> => {
  const { libraryId } = await owner.music.run("libraries.create", {
    name,
    path: `/music/${name}`,
    visibility,
  });

  await upsertFiles(backend, libraryId, files);
  const id = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", libraryId));

  if (id === null) throw new Error(`${libraryId} is not a library`);

  return id;
};

const setup = async (files: ReadonlyArray<SeedFile> = SONGS) => {
  const backend = makeBackend();
  const owner = await signUp(backend, "owner");
  const member = await signUp(backend, "member");
  const libraryId = await libraryOf(backend, owner, "Songs", "shared", files);

  await member.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });

  const tracks = await allTracks(member);

  const id = (title: string): TrackId => {
    const track = tracks.find((candidate) => candidate.title === title);

    if (track === undefined) throw new Error(`No track titled ${title}`);

    return track.id;
  };

  return { backend, owner, member, libraryId, id };
};

const changesFor = (user: User, held: ReadonlyArray<HeldLyrics>) =>
  user.music.read("downloads.lyrics", { held: [...held] });

/** What a device keeps for `trackIds` before it has any lyrics. */
const nothingHeld = (trackIds: ReadonlyArray<TrackId>): ReadonlyArray<HeldLyrics> =>
  trackIds.map((trackId) => ({ trackId, rev: null }));

/** A change without its revision, which is opaque; null lyrics for a removal. */
interface Content {
  readonly trackId: TrackId;
  readonly lyrics: TrackLyrics | null;
}

/** What `changes` say without their revisions. */
const contents = (changes: ReadonlyArray<LyricsChange>): ReadonlyArray<Content> =>
  changes.map((change) =>
    LyricsChange.match(change, {
      Changed: ({ trackId, lyrics }): Content => ({ trackId, lyrics }),
      Removed: ({ trackId }): Content => ({ trackId, lyrics: null }),
    }),
  );

/** The revisions a device keeps once it applied `changes` over `held`. */
const applied = (
  held: ReadonlyArray<HeldLyrics>,
  changes: ReadonlyArray<LyricsChange>,
): ReadonlyArray<HeldLyrics> =>
  held.map(({ trackId, rev }) => {
    const change = changes.find((each) => each.trackId === trackId);

    if (change === undefined) return { trackId, rev };

    return {
      trackId,
      rev: LyricsChange.match(change, { Changed: ({ rev: next }) => next, Removed: () => null }),
    };
  });

/** The revision `changes` give `trackId`. */
const revisionIn = (changes: ReadonlyArray<LyricsChange>, trackId: TrackId): LyricsRevision => {
  const change = changes.find((each) => each.trackId === trackId);

  if (change === undefined || !LyricsChange.guards.Changed(change)) {
    throw new Error(`No new lyrics for ${trackId}`);
  }

  return change.rev;
};

/** Claims and answers the lookup `trackId`'s tags make, as the media service does. */
const answerLookup = async (
  backend: Backend,
  trackId: TrackId,
  answer: { kind: "found"; recordId: number; sets: Array<typeof LRCLIB> } | { kind: "miss" },
): Promise<void> => {
  const row = await backend.run(async (ctx) => {
    const id = ctx.db.normalizeId("tracks", trackId);
    const key = id === null ? undefined : (await ctx.db.get(id))?.lookupKey;

    return key === undefined
      ? null
      : ctx.db
          .query("lyricLookups")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique();
  });

  if (row === null) throw new Error(`No lookup for ${trackId}`);

  const workerId = "worker-1";

  await backend.mutation(api.media.claimLookup, {
    secret: MEDIA_SECRET,
    lookupId: row._id,
    workerId,
  });
  await backend.mutation(api.media.saveLookup, {
    secret: MEDIA_SECRET,
    lookupId: row._id,
    workerId,
    answer,
  });
};

describe("downloads.lyrics", () => {
  it("sends the lyrics a device lacks as a device without the server shows them, then nothing", async () => {
    const { member, id } = await setup();
    const held = nothingHeld([id("Synced"), id("Plain"), id("None")]);
    const first = await changesFor(member, held);

    expect(contents(first)).toEqual([
      {
        trackId: id("Synced"),
        lyrics: { _tag: "Synced", source: "file", main: SYNCED, extras: [] },
      },
      {
        trackId: id("Plain"),
        lyrics: { _tag: "Plain", source: "file", main: PLAIN, extras: [] },
      },
    ]);

    expect(await changesFor(member, applied(held, first))).toEqual([]);
  });

  it("moves a revision when a song's own lyrics change, and removes them once it has none", async () => {
    const { backend, member, libraryId, id } = await setup();
    const held = nothingHeld([id("Plain")]);
    const kept = applied(held, await changesFor(member, held));

    const saveLyrics = (lyricsFiles: string, lyrics: Array<StoredLyricSet>) =>
      backend.mutation(api.media.saveLocalLyrics, {
        secret: MEDIA_SECRET,
        libraryId,
        tracks: [{ path: "plain.flac", lyricsFiles, lyricsReader: 1, lyrics }],
      });

    await saveLyrics("plain.lrc:40:1000", [SYNCED]);
    const edited = await changesFor(member, kept);

    expect(contents(edited)).toEqual([
      {
        trackId: id("Plain"),
        lyrics: { _tag: "Synced", source: "file", main: SYNCED, extras: [] },
      },
    ]);
    expect(revisionIn(edited, id("Plain"))).not.toBe(kept[0]?.rev);

    await saveLyrics("", []);
    expect(contents(await changesFor(member, applied(kept, edited)))).toEqual([
      { trackId: id("Plain"), lyrics: null },
    ]);
  });

  it("keeps nothing while LRCLIB is asked, and moves the revision once it answers, never the song's", async () => {
    const { backend, member, id } = await setup([
      { path: "remote.flac", title: "Remote", artist: "Band" },
      { path: "own.flac", title: "Own", artist: "Band", lyrics: [PLAIN] },
    ]);

    const { pinId } = await member.music.run("downloads.add", {
      deviceId: PHONE,
      kind: "track",
      id: id("Remote"),
    });

    await member.music.run("downloads.add", { deviceId: PHONE, kind: "track", id: id("Own") });
    await drainScheduled(backend);

    // Both lookups are queued: the song without lyrics keeps none, the other its own words.
    const held = nothingHeld([id("Remote"), id("Own")]);
    const pending = await changesFor(member, held);

    expect(contents(pending)).toEqual([
      {
        trackId: id("Own"),
        lyrics: { _tag: "Plain", source: "file", main: PLAIN, extras: [] },
      },
    ]);

    const manifest = await member.music.read("downloads.manifest", { pinId });

    await answerLookup(backend, id("Remote"), { kind: "found", recordId: 7, sets: [LRCLIB] });
    await answerLookup(backend, id("Own"), { kind: "found", recordId: 7, sets: [LRCLIB] });

    const found = await changesFor(member, applied(held, pending));

    expect(contents(found)).toEqual([
      {
        trackId: id("Remote"),
        lyrics: { _tag: "Synced", source: "lrclib", main: LRCLIB, extras: [] },
      },
      {
        trackId: id("Own"),
        lyrics: { _tag: "Synced", source: "lrclib", main: LRCLIB, extras: [] },
      },
    ]);
    expect(revisionIn(found, id("Own"))).not.toBe(revisionIn(pending, id("Own")));

    // New lyrics never fetch the song again.
    expect(await member.music.read("downloads.manifest", { pinId })).toEqual(manifest);
  });

  it("moves a revision when a move brings other lyrics of the same size, file, and time", async () => {
    const OLD: StoredLyricSet = { ...PLAIN, body: { _tag: "Plain", text: "old" } };
    const NEW: StoredLyricSet = { ...PLAIN, body: { _tag: "Plain", text: "new" } };

    const { backend, member, libraryId, id } = await setup([
      { path: "a/song.flac", title: "Song", lyrics: [OLD] },
    ]);

    const held = nothingHeld([id("Song")]);
    const kept = applied(held, await changesFor(member, held));

    // The file moves beside a lyric file with the same name, size, and time, holding other words.
    await backend.mutation(api.media.moveTracks, {
      secret: MEDIA_SECRET,
      libraryId,
      moves: [
        {
          from: "a/song.flac",
          track: {
            path: "b/song.flac",
            size: 1000,
            mtimeMs: 1_700_000_000_000,
            title: "Song",
            artist: "Artist",
            album: "Album",
            durationMs: 180_000,
            codec: "flac",
            lossless: true,
            artHash: "0".repeat(64),
            ...NO_LYRICS,
            lyrics: [NEW],
          },
        },
      ],
    });

    expect(contents(await changesFor(member, kept))).toEqual([
      { trackId: id("Song"), lyrics: { _tag: "Plain", source: "file", main: NEW, extras: [] } },
    ]);
  });

  it("keeps a song's revision when LRCLIB answers, as its own synced lyrics win", async () => {
    // Tags that fold alike: both songs share one LRCLIB lookup.
    const tags = { artist: "Band", album: "Album", durationMs: 200_000 };

    const { backend, member, id } = await setup([
      { path: "own.flac", title: "Twin", ...tags, lyrics: [SYNCED] },
      { path: "other.flac", title: "TWIN", ...tags },
    ]);

    const held = nothingHeld([id("Twin")]);
    const kept = applied(held, await changesFor(member, held));

    await member.music.run("downloads.add", { deviceId: PHONE, kind: "track", id: id("TWIN") });
    await drainScheduled(backend);
    await answerLookup(backend, id("TWIN"), { kind: "found", recordId: 7, sets: [LRCLIB] });

    expect(contents(await changesFor(member, nothingHeld([id("TWIN")])))).toEqual([
      {
        trackId: id("TWIN"),
        lyrics: { _tag: "Synced", source: "lrclib", main: LRCLIB, extras: [] },
      },
    ]);
    expect(await changesFor(member, kept)).toEqual([]);
  });

  it("removes the lyrics of songs the person can't read, and tells nothing of songs they never had", async () => {
    const { backend, owner, member, id } = await setup();

    await libraryOf(backend, owner, "Mine", "private", [
      { path: "private.flac", title: "Private", lyrics: [SYNCED] },
    ]);

    const hidden = (await allTracks(owner)).find((track) => track.title === "Private")?.id;

    if (hidden === undefined) throw new Error("No private song");
    const owned = await changesFor(owner, nothingHeld([hidden]));

    expect(owned).toHaveLength(1);

    // Another person's phone asking with the owner's revision learns only that it holds none.
    expect(contents(await changesFor(member, applied(nothingHeld([hidden]), owned)))).toEqual([
      { trackId: hidden, lyrics: null },
    ]);
    expect(
      contents(await changesFor(member, nothingHeld([hidden, id("Synced")]))).map(
        ({ trackId }) => trackId,
      ),
    ).toEqual([id("Synced")]);
  });
});

/** About 600 KB of lyrics, as large lyric files can hold. */
const large = (index: number): StoredLyricSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Embedded", tag: "other" },
  body: { _tag: "Plain", text: `${index} ${"la ".repeat(200_000)}` },
});

/** About 600 KB of lyrics from LRCLIB. */
const largeAnswer = (index: number): typeof LRCLIB => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Lrclib", recordId: index },
  body: { _tag: "Plain", text: `${index} ${"la ".repeat(200_000)}` },
});

/** How much one `downloads.lyrics` read sends at most, unless its one song's lyrics are more. */
const PAGE_BYTES = 8 * 1024 ** 2;

/** One read's answer: how many songs it sent, and their size as JSON. */
interface Page {
  readonly songs: number;
  readonly bytes: number;
}

const pageOf = (changes: ReadonlyArray<LyricsChange>): Page => ({
  songs: changes.length,
  bytes: changes.reduce((total, change) => total + JSON.stringify(change).length, 0),
});

/** Asks `downloads.lyrics` until nothing changed; the revisions kept, and each page it sent. */
const allPages = async (
  user: User,
  held: ReadonlyArray<HeldLyrics>,
  pages: ReadonlyArray<Page> = [],
): Promise<{ held: ReadonlyArray<HeldLyrics>; pages: ReadonlyArray<Page> }> => {
  const changes = await changesFor(user, held);

  return changes.length === 0
    ? { held, pages }
    : allPages(user, applied(held, changes), [...pages, pageOf(changes)]);
};

/** Every song's lyrics arrived over several pages, none past `PAGE_BYTES`. */
const expectPaged = (
  { held, pages }: { held: ReadonlyArray<HeldLyrics>; pages: ReadonlyArray<Page> },
  songs: number,
): void => {
  expect(held.every(({ rev }) => rev !== null)).toBe(true);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.reduce((total, page) => total + page.songs, 0)).toBe(songs);
  expect(pages.filter((page) => page.songs > 1 && page.bytes > PAGE_BYTES)).toEqual([]);
};

/** Thirty song paths, in the order a scan lists them. */
const PATHS = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")}.flac`);

describe("downloads.lyrics with large lyrics", () => {
  it("sends a song's own lyrics in pages Convex can read until the device holds every song's", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const libraryId = await libraryOf(backend, owner, "Crowded", "shared", []);

    // Three songs a write: their lyrics are about as much as one write may send.
    await Array.from({ length: PATHS.length / 3 }, (_, batch) => batch * 3).reduce(
      async (previous, start) => {
        await previous;
        await upsertFiles(
          backend,
          libraryId,
          PATHS.slice(start, start + 3).map((path, offset) => ({
            path,
            lyrics: [large(start + offset)],
          })),
        );
      },
      Promise.resolve(),
    );

    const songs = (await allTracks(owner)).map((track) => track.id);

    expectPaged(await allPages(owner, nothingHeld(songs)), songs.length);
  });

  it("sends LRCLIB's lyrics in pages Convex can read too", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    await owner.music.run("devices.heartbeat", { deviceId: PHONE, name: "iPhone", kind: "phone" });

    const libraryId = await libraryOf(
      backend,
      owner,
      "Remote",
      "shared",
      PATHS.map((path) => ({ path, artist: "Band" })),
    );

    const tracks = await allTracks(owner);
    const albumId = tracks[0]?.albumId;

    if (albumId === undefined) throw new Error(`No songs in ${libraryId}`);
    await owner.music.run("downloads.add", { deviceId: PHONE, kind: "album", id: albumId });
    await drainScheduled(backend);

    await tracks.reduce(async (previous, track, index) => {
      await previous;
      await answerLookup(backend, track.id, {
        kind: "found",
        recordId: index + 1,
        sets: [largeAnswer(index + 1)],
      });
    }, Promise.resolve());

    expectPaged(await allPages(owner, nothingHeld(tracks.map((track) => track.id))), tracks.length);
  });
});
