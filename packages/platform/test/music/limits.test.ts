import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { fitLyrics, lyricsFieldsOf } from "../../convex/music/fit";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member } from "../devices";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  catalogRowsOf,
  claimScan,
  finishScan,
  leftOf,
  lyricRowsOf,
  markMissingAll,
  musicLibrary,
  purgePage,
  rowsOf,
  saveLyricsAll,
  setFoldersQuietly,
  totalsOf,
  trackIdsAt,
  trackState,
  upsert,
  upsertAll,
} from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";
import type { LyricSet, ScannedTrack } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

const BYTES_MAX = 16 * 1024 * 1024;

/** What a music call lets itself read and write: 12 MiB each way (`music/budget.ts`). */
const CALL_BYTES = 12 * 1024 * 1024;

/**
 * Whether every call stayed inside Convex's limits, and inside the bytes the music budget lets a
 * call spend, which it can only do when the music store charged each byte Convex counted.
 */
const inside = (calls: ReadonlyArray<CallUsage>): boolean =>
  calls.every(
    (call) =>
      call.reads < READS_MAX &&
      call.writes < WRITES_MAX &&
      call.bytes <= CALL_BYTES &&
      call.writeBytes <= CALL_BYTES,
  ) && calls.every((call) => call.bytes < BYTES_MAX && call.writeBytes < BYTES_MAX);

/** About 200 KB of plain lyrics, different for each track and round. */
const verse = (n: number, round: number) => plainLyrics(`${round}:${n} `.repeat(30_000));

/** `count` characters of a 3-byte character, the longest a name's characters can be. */
const wide = (count: number, n: number): string => `${n}`.padEnd(count, "語");

/** `length` characters of plain lyrics, different for each `n` and round. */
const lyricsOf = (length: number, n: number, round = 1): LyricSet =>
  plainLyrics(`${round}:${n} `.padEnd(length, "la "));

/**
 * File `n` with every field long, about 19 KB as a track row, on one of eleven albums by as many
 * artists, all with long names.
 */
const longTrack = (root: string, n: number, lyrics: ReadonlyArray<LyricSet>): ScannedTrack =>
  musicTrack(`${root}/${n}/${wide(1300, n)}.flac`, 1000, 1, {
    title: wide(600, n),
    artist: wide(600, n % 11),
    album: wide(600, n % 11),
    genre: wide(200, n % 11),
    artHash: `${n}`.padStart(64, "0"),
    folderArt: wide(1200, n),
    lyricsFiles: wide(1200, n),
    lyrics: [...lyrics],
  });

/**
 * 8,192 lyric sets of `length` characters each: Convex holds at most 8,192 items in an array, and
 * 1,800 characters each fill most of the 16 MiB a call's arguments may hold.
 */
const manySets = (length: number): ReadonlyArray<LyricSet> =>
  Array.from({ length: 8192 }, (_, n) => plainLyrics(`${n} `.padEnd(length, "la ")));

/** The lyrics hash each track keeps for its file's lyrics, as the music writer fits them. */
const hashesOf = (tracks: ReadonlyArray<ScannedTrack>): Promise<ReadonlyArray<string | null>> =>
  Promise.all(
    tracks.map(async (track) => (await lyricsFieldsOf(fitLyrics(track.lyrics))).lyricsHash),
  );

/** A lyric set as small as one can be: one character of plain text from an unnamed tag. */
const tinySet = (text: string): LyricSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Embedded", tag: "other" },
  body: { _tag: "Plain", text },
});

const exact = async (core: CoreStack, libraryId: Id<"libraries">): Promise<boolean> => {
  const [rows, totals] = await Promise.all([rowsOf(core, libraryId), totalsOf(core, libraryId)]);

  return (
    rows.tracks === totals.tracks &&
    rows.albums === totals.albums &&
    rows.artists === totals.artists &&
    rows.durationMs === totals.durationMs
  );
};

const idsAt = async (
  core: CoreStack,
  libraryId: Id<"libraries">,
  tracks: ReadonlyArray<ScannedTrack>,
): Promise<ReadonlyArray<Id<"tracks">>> =>
  (
    await trackIdsAt(
      core,
      libraryId,
      tracks.map((track) => track.path),
    )
  ).flatMap((id) => (id === null ? [] : [id]));

interface Page {
  readonly cursor: string | null;
  readonly more: boolean;
}

/** Every page of a library's music purge of tracks, from the start, as the hook runs them. */
const purgeAll = async (
  core: CoreStack,
  libraryId: Id<"libraries">,
  cursor: string | null = null,
  pages: ReadonlyArray<Page> = [],
): Promise<ReadonlyArray<Page>> => {
  const page = await purgePage(core, libraryId, "tracks", cursor);
  const next = [...pages, page];

  return page.more ? purgeAll(core, libraryId, page.cursor, next) : next;
};

/**
 * Removes the second of the library's two folders, whose tracks are `dropped`, and runs the purge
 * page by page; answers its pages and each page's usage once the dropped tracks and their lyrics
 * are gone and the totals equal the rows again.
 */
const purgeDropped = async (
  core: CoreStack,
  libraryId: Id<"libraries">,
  kept: string,
  dropped: ReadonlyArray<ScannedTrack>,
) => {
  const ids = await idsAt(core, libraryId, dropped);

  expect(ids).toHaveLength(dropped.length);

  await setFoldersQuietly(core, libraryId, [kept]);

  const mark = await logMark(core);
  const pages = await purgeAll(core, libraryId);
  const usage = await usageSince(core, mark, internal.music.probe.purgePage, pages.length);

  expect(await leftOf(core, ids)).toEqual({ tracks: 0, lyrics: 0 });
  expect(await exact(core, libraryId)).toBe(true);

  return { pages, usage };
};

describe.skipIf(stack === undefined)("music call limits", { timeout: 600_000 }, () => {
  it("write 500 singles, each its own album and artist at the longest names, inside each call's limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "singles-admin", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Singles");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = Array.from({ length: 500 }, (_, n) =>
      musicTrack(`${root}/${n}/${wide(200, n)}.flac`, 1000, 1, {
        title: wide(600, n),
        artist: wide(600, n),
        album: wide(600, n),
        genre: wide(200, n),
        artHash: `${n}`.padStart(64, "0"),
        folderArt: wide(1200, n),
        lyricsFiles: wide(1200, n),
      }),
    );

    const lease = await claimScan(stack, scanJobId);
    const mark = await logMark(stack);
    const written = await upsertAll(stack, lease, tracks);
    const usage = await usageSince(stack, mark, api.music.scanner.upsert, written.length);

    expect(written.reduce((sum, call) => sum + call.done, 0)).toBe(500);
    expect(written.every((call) => call.done > 0)).toBe(true);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({
      tracks: 500,
      albums: 500,
      artists: 500,
    });

    const missingMark = await logMark(stack);

    const marked = await markMissingAll(
      stack,
      lease,
      tracks.map((track) => track.path),
    );

    const missingUsage = await usageSince(
      stack,
      missingMark,
      api.music.scanner.missing,
      marked.length,
    );

    expect(inside(missingUsage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 0, albums: 0, artists: 0 });
    expect((await rowsOf(stack, libraryId)).rows).toBe(500);

    await finishScan(stack, lease);
  });

  it("rewrite tracks with large lyrics, reading and writing each call's bytes inside the limit", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "lyrics-limits", "admin");
    const { scanJobId, roots } = await musicLibrary(admin, "Long lyrics");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = (round: number) =>
      Array.from({ length: 24 }, (_, n) =>
        musicTrack(`${root}/Album/${n}.flac`, 1000 + round, round, { lyrics: [verse(n, round)] }),
      );

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, tracks(1));

    const mark = await logMark(stack);
    const written = await upsertAll(stack, lease, tracks(2));
    const usage = await usageSince(stack, mark, api.music.scanner.upsert, written.length);

    expect(written.reduce((sum, call) => sum + call.done, 0)).toBe(24);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);

    await finishScan(stack, lease);
  });

  it("rewrite 24 tracks with 512,000 characters of lyrics each in calls that stop on their byte budget", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "longest-lyrics", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Longest lyrics");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = (round: number, lyricsRound = round) =>
      Array.from({ length: 24 }, (_, n) =>
        musicTrack(`${root}/Album/${n}.flac`, 1000 + round, round, {
          lyrics: [lyricsOf(512_000, n, lyricsRound)],
        }),
      );

    const lease = await claimScan(stack, scanJobId);
    const firstMark = await logMark(stack);
    const first = await upsertAll(stack, lease, tracks(1));
    const firstUsage = await usageSince(stack, firstMark, api.music.scanner.upsert, first.length);
    const mark = await logMark(stack);
    const written = await upsertAll(stack, lease, tracks(2));
    const usage = await usageSince(stack, mark, api.music.scanner.upsert, written.length);
    // Files changed again with the same lyrics: their rows are read, compared, and not written.
    const retagMark = await logMark(stack);
    const rescanned = await upsertAll(stack, lease, tracks(3, 2));

    const retagUsage = await usageSince(
      stack,
      retagMark,
      api.music.scanner.upsert,
      rescanned.length,
    );

    await finishScan(stack, lease);

    // Writing 24 rows of 500 KiB fits a call's 12 MiB; rewriting them reads each twice, and does not.
    expect(first.reduce((sum, call) => sum + call.done, 0)).toBe(24);
    expect(written[0]?.done).toBeLessThan(24);
    expect(written.reduce((sum, call) => sum + call.done, 0)).toBe(24);
    expect(rescanned.reduce((sum, call) => sum + call.done, 0)).toBe(24);
    expect(retagUsage.every((call) => call.writeBytes < 1024 * 1024)).toBe(true);

    expect(inside([...firstUsage, ...usage, ...retagUsage].filter((call) => call.committed))).toBe(
      true,
    );

    const ids = await idsAt(stack, libraryId, tracks(2));
    const states = await Promise.all(ids.map(async (id) => trackState(stack, id)));

    expect(states.map((state) => state?.lyricsHash)).toEqual(await hashesOf(tracks(2)));
    expect(states.every((state) => state?.lyricsBytes !== null)).toBe(true);
    expect(await leftOf(stack, ids)).toEqual({ tracks: 24, lyrics: 24 });
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 24, albums: 1, artists: 1 });
    expect(await exact(stack, libraryId)).toBe(true);
  });

  it("purge a folder of 341 tracks with long fields and 20,000 characters of lyrics in pages that stop on their byte budget", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "long-purge", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Long purge", 2);
    const [kept, gone] = roots;

    if (kept === undefined || gone === undefined) throw new Error("two folders");

    const keptTracks = Array.from({ length: 3 }, (_, n) =>
      musicTrack(`${kept}/Stays/${n}.flac`, 1000, 1, { artist: "Stays", album: "Stays" }),
    );

    const dropped = Array.from({ length: 341 }, (_, n) =>
      longTrack(gone, n, [lyricsOf(20_000, n)]),
    );

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, [...keptTracks, ...dropped]);
    await finishScan(stack, lease);

    const { pages, usage } = await purgeDropped(stack, libraryId, kept, dropped);

    expect(pages[0]).toEqual({ cursor: null, more: true });
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 3, albums: 1, artists: 1 });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 1, artists: 1 });
  });

  it("delete 341 tracks with long fields in purge pages that charge each delete's read and stop on their byte budget", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "delete-purge", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Long deletes", 2);
    const [kept, gone] = roots;

    if (kept === undefined || gone === undefined) throw new Error("two folders");

    const keptTracks = Array.from({ length: 3 }, (_, n) =>
      musicTrack(`${kept}/Stays/${n}.flac`, 1000, 1, { artist: "Stays", album: "Stays" }),
    );

    const dropped = Array.from({ length: 341 }, (_, n) => longTrack(gone, n, []));
    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, [...keptTracks, ...dropped]);
    await finishScan(stack, lease);

    const { pages, usage } = await purgeDropped(stack, libraryId, kept, dropped);

    expect(pages[0]).toEqual({ cursor: null, more: true });
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 3, albums: 1, artists: 1 });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 1, artists: 1 });
  });

  it("write a track of 8,192 lyric sets, and one of as many sets as a call's 16 MiB holds, well inside the time limit", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "many-sets", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Many sets");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = [
      musicTrack(`${root}/Album/hundred.flac`, 1000, 1, { lyrics: [...manySets(100)] }),
      musicTrack(`${root}/Album/largest.flac`, 1000, 1, { lyrics: [...manySets(1800)] }),
    ];

    const lease = await claimScan(stack, scanJobId);
    const mark = await logMark(stack);

    const written = await Promise.all(
      tracks.map(async (track) => {
        const answer = await upsert(stack, lease, [track]);

        return answer.outcome === "held" ? answer.value.done : 0;
      }),
    );

    const usage = await usageSince(stack, mark, api.music.scanner.upsert, tracks.length);

    await finishScan(stack, lease);

    expect(written).toEqual([1, 1]);
    expect(usage.filter((call) => call.committed).every((call) => call.seconds < 0.75)).toBe(true);

    const states = await Promise.all(
      (await idsAt(stack, libraryId, tracks)).map(async (id) => trackState(stack, id)),
    );

    expect(states.map((state) => state?.lyricsHash)).toEqual(await hashesOf(tracks));
  });

  it("rescan 16 tracks of 6,470 one-character lyric sets, the same or changed in the last, in calls well inside the time limit", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "dense-lyrics", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Dense lyrics");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    // As many of the smallest sets as a lyrics row holds, 11 MB of arguments for the 16 tracks.
    const sets = fitLyrics(Array.from({ length: 8192 }, () => tinySet("x")));
    const changed = [...sets.slice(0, -1), tinySet("y")];

    const tracks = (lyrics: ReadonlyArray<LyricSet>) =>
      Array.from({ length: 16 }, (_, n) =>
        musicTrack(`${root}/Album/${n}.flac`, 1000, 1, { lyrics: [...lyrics] }),
      );

    const files = (lyrics: ReadonlyArray<LyricSet>) =>
      tracks(lyrics).map((track) => ({
        path: track.path,
        lyricsFiles: track.lyricsFiles,
        lyricsReader: track.lyricsReader,
        lyrics: [...lyrics],
      }));

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, tracks(sets));

    const ids = await idsAt(stack, libraryId, tracks(sets));

    expect(sets.length).toBe(6470);
    expect(ids).toHaveLength(16);

    /** Runs a rescan, and answers its calls' usage once the rows hold `lyrics`. */
    const rescan = async (
      name: "upsert" | "lyrics",
      send: () => Promise<ReadonlyArray<{ readonly done: number }>>,
      lyrics: ReadonlyArray<LyricSet>,
    ) => {
      const mark = await logMark(stack);
      const calls = await send();
      const usage = await usageSince(stack, mark, api.music.scanner[name], calls.length);
      const rows = await Promise.all(ids.map(async (id) => lyricRowsOf(stack, id)));

      expect(calls.length).toBeGreaterThan(1);
      expect(calls.reduce((sum, call) => sum + call.done, 0)).toBe(16);
      expect(usage.every((call) => call.committed && call.seconds < 0.75)).toBe(true);
      expect(inside(usage)).toBe(true);
      expect(rows.map((found) => found.map((row) => row.sets))).toEqual(ids.map(() => [lyrics]));

      return usage;
    };

    const same = [
      ...(await rescan("upsert", async () => upsertAll(stack, lease, tracks(sets)), sets)),
      ...(await rescan("lyrics", async () => saveLyricsAll(stack, lease, files(sets)), sets)),
    ];

    const patched = [
      ...(await rescan("upsert", async () => upsertAll(stack, lease, tracks(changed)), changed)),
      ...(await rescan("lyrics", async () => saveLyricsAll(stack, lease, files(sets)), sets)),
    ];

    await finishScan(stack, lease);

    // The same sets are compared and not written; a set changed in the last rewrites each row.
    expect(same.every((call) => call.writeBytes < 64 * 1024)).toBe(true);
    expect(patched.every((call) => call.writeBytes > 512 * 1024)).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 16, albums: 1, artists: 1 });
  });
});
