import { join } from "node:path";

import { Effect, HashSet, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { artPath } from "./art-store.ts";
import {
  describeScan,
  LibraryEmpty,
  LibraryUnavailable,
  pathRanges,
  scanLibrary,
  storedFingerprint,
  type ScanProgress,
} from "./music-scan.ts";
import {
  coreFingerprint,
  makeDirectory,
  MEDIA_TEST_TIMEOUT,
  memoryCatalog,
  type MemoryCatalog,
  moveFile,
  PNG,
  removeDirectory,
  setFileTime,
  sizeOf,
  writeBytes,
  writeSong,
} from "./testing/music-fixtures.ts";

let work = "";

beforeEach(async () => {
  work = await makeDirectory("scan");
});

afterEach(async () => {
  await removeDirectory(work);
});

const scanOnce = (memory: MemoryCatalog, folders: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const progress = yield* Ref.make<ScanProgress>({ done: 0, total: null, message: "" });
    const released = yield* Ref.make(HashSet.empty<string>());

    return yield* scanLibrary(
      { libraryId: "library", folders, dataDir: join(work, "data") },
      memory.catalog,
      progress,
      released,
    );
  });

describe("storedFingerprint", () => {
  it("keeps what the core keeps: short text as it is, long text bounded with its hash", () => {
    const short = "Artist/Album/cover.jpg:1:2";
    const long = `${"a".repeat(958)}\u{1F3B5}${"b".repeat(400)}`;

    expect(storedFingerprint(short)).toBe(short);
    expect(storedFingerprint(long)).toBe(coreFingerprint(long));
    expect(storedFingerprint(long)).toHaveLength(1023);
    expect(storedFingerprint(`${long}c`)).not.toBe(storedFingerprint(long));
  });
});

describe("pathRanges", () => {
  it("covers every path once, in the core's code point order", () => {
    const paths = ["/m/b", "/m/\u{1F3B5}", "/m/Ａ", "/m/a", "/m/c"];
    const ranges = pathRanges(paths, 2);

    expect(ranges).toEqual([
      { from: undefined, to: "/m/c" },
      { from: "/m/c", to: "/m/\u{1F3B5}" },
      { from: "/m/\u{1F3B5}", to: undefined },
    ]);
  });
});

describe("scanLibrary", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("writes each song with its tags, art, lyrics, and explicit flag, and nothing on a rescan", async () => {
    const root = join(work, "music");

    // A folder deep enough that its artwork's fingerprint passes the core's 1,024 characters.
    const deep = join(
      root,
      ...Array.from({ length: 6 }, (_, level) => `${"Deep".repeat(48)}${level}`),
    );

    await writeSong(join(root, "Sintel Band", "First", "01 Opening.flac"), {
      seconds: 1,
      tags: {
        title: "Opening",
        artist: "Sintel Band",
        album: "First",
        track: "1",
        date: "2010",
        genre: "Score",
        ITUNESADVISORY: "1",
      },
    });
    await writeBytes(join(root, "Sintel Band", "First", "cover.png"), PNG);
    await writeBytes(join(root, "Sintel Band", "First", "01 Opening.lrc"), "[00:00.50]Hello\n");
    await writeSong(join(root, "Loose Track.mp3"), { seconds: 1 });
    await writeSong(join(deep, "Deep Song.flac"), { seconds: 1, tags: { title: "Deep" } });
    await writeBytes(join(deep, "folder.png"), PNG);

    const memory = await Effect.runPromise(memoryCatalog);
    const summary = await Effect.runPromise(scanOnce(memory, [root]));

    expect(summary).toEqual({ files: 3, updated: 3, moved: 0, missing: 0, failed: 0 });
    expect(describeScan(summary)).toBe("3 files, 3 updated, 0 missing");

    const tracks = await Effect.runPromise(memory.tracks);
    const opening = tracks.get(join(root, "Sintel Band", "First", "01 Opening.flac"));
    const loose = tracks.get(join(root, "Loose Track.mp3"))?.track;
    const deepSong = tracks.get(join(deep, "Deep Song.flac"))?.track;

    expect(opening?.track).toMatchObject({
      title: "Opening",
      artist: "Sintel Band",
      album: "First",
      trackNumber: 1,
      year: 2010,
      genre: "Score",
      codec: "flac",
      lossless: true,
      explicit: true,
    });
    expect(opening?.track.folderArt).toMatch(/^Sintel Band\/First\/cover\.png:/u);
    expect(opening?.lyrics.lyricsFiles).toMatch(/^01 Opening\.lrc:/u);
    expect(opening?.lyrics.lyrics).toHaveLength(1);
    expect(opening?.track.artHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await sizeOf(artPath(join(work, "data"), opening?.track.artHash ?? ""))).toBe(
      PNG.length,
    );
    expect(loose).toMatchObject({
      title: "Loose Track",
      artist: "Unknown Artist",
      album: "Unknown Album",
      codec: "mp3",
      explicit: false,
    });
    expect(loose === undefined ? [] : Object.keys(loose)).not.toContain("albumArtist");
    expect(loose === undefined ? [] : Object.keys(loose)).not.toContain("artHash");
    expect(deepSong?.folderArt?.length).toBeGreaterThan(1024);

    await Effect.runPromise(memory.writes);

    const again = await Effect.runPromise(scanOnce(memory, [root]));

    expect(again).toEqual({ files: 3, updated: 0, moved: 0, missing: 0, failed: 0 });
    expect(await Effect.runPromise(memory.writes)).toEqual({
      upserted: [],
      moved: [],
      missing: [],
      lyrics: [],
    });
  });

  it("follows a moved song, marks a deleted one missing, and reads only lyrics when a lyric file changes", async () => {
    const root = join(work, "music");
    const first = join(root, "Album", "01 One.flac");
    const second = join(root, "Album", "02 Two.flac");

    await writeSong(first, { seconds: 1, tags: { title: "One", album: "Album" } });
    await writeSong(second, { seconds: 2, tags: { title: "Two", album: "Album" } });

    const memory = await Effect.runPromise(memoryCatalog);

    await Effect.runPromise(scanOnce(memory, [root]));
    await Effect.runPromise(memory.writes);

    const moved = join(root, "Renamed", "One Again.flac");

    await writeBytes(join(root, "Renamed", ".keep"), "");
    await moveFile(first, moved);
    await removeDirectory(second);
    await writeBytes(join(root, "Album", "01 One.txt"), "Words");

    const summary = await Effect.runPromise(scanOnce(memory, [root]));
    const writes = await Effect.runPromise(memory.writes);

    expect(summary).toEqual({ files: 1, updated: 0, moved: 1, missing: 1, failed: 0 });
    expect(writes.moved.map((move) => [move.from, move.track.path])).toEqual([[first, moved]]);
    expect(writes.missing).toEqual([second]);

    await writeBytes(join(root, "Renamed", "One Again.txt"), "Words");
    await setFileTime(join(root, "Renamed", "One Again.txt"), 1_700_000_000_000);

    const lyricsOnly = await Effect.runPromise(scanOnce(memory, [root]));

    expect(lyricsOnly.updated).toBe(1);
    expect(await Effect.runPromise(memory.writes)).toMatchObject({ upserted: [], lyrics: [moved] });
  });

  it("stops without marking anything missing when a folder the core knows songs in is empty", async () => {
    const root = join(work, "music");
    const other = join(work, "other");

    await writeSong(join(root, "Song.flac"), { seconds: 1 });
    await writeSong(join(other, "Kept.flac"), { seconds: 1 });

    const memory = await Effect.runPromise(memoryCatalog);

    await Effect.runPromise(scanOnce(memory, [root, other]));
    await removeDirectory(join(root, "Song.flac"));

    const failed = await Effect.runPromise(Effect.flip(scanOnce(memory, [root, other])));

    expect(failed).toBeInstanceOf(LibraryEmpty);
    expect(failed.message).toContain(root);
    expect((await Effect.runPromise(memory.writes)).missing).toEqual([]);

    const unreadable = await Effect.runPromise(
      Effect.flip(scanOnce(memory, [join(work, "nowhere")])),
    );

    expect(unreadable).toBeInstanceOf(LibraryUnavailable);
  });
});
