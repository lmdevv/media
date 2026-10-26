import { Buffer } from "node:buffer";
import { basename, join } from "node:path";

import { LyricsLookup, resolveLyrics } from "@music/commands/lyrics";
import { describe, expect, it } from "vitest";
import { Effect, HashSet, Layer, Ref } from "effect";

import { runTool } from "./ffmpeg.ts";
import * as Files from "./files.ts";
import type { JobProgress } from "./media-backend.ts";
import { scanLibrary } from "./scan.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  temporaryDirectory,
  testConfig,
} from "./testing/fixtures.ts";
import { layerMemory, MemoryMediaBackendControl } from "./testing/memory-media-backend.ts";
import { setFileTime } from "./testing/file-times.ts";
import { makeUnreadable, runsAsRoot } from "./testing/permissions.ts";
import { runScoped } from "./testing/run.ts";

const NEON = "Aurora Tones/Night Drive/01 Neon.mp3";

const OVERPASS = "Aurora Tones/Night Drive/02 Overpass.mp3";

const DOPPELGANGER = "Aurora Tones/Night Drive/03 Doppelgänger.mp3";

const DAWN = "Aurora Tones/First Light/01 Dawn.flac";

const encoder = new TextEncoder();

/** `lines` lines of LRC, half a second apart, each about `width` characters long. */
const lrc = (lines: number, width = 20): string =>
  Array.from({ length: lines }, (_, index) => {
    const ms = index * 500;
    const minutes = String(Math.floor(ms / 60_000)).padStart(2, "0");
    const seconds = ((ms % 60_000) / 1000).toFixed(2).padStart(5, "0");

    return `[${minutes}:${seconds}]Line ${index} ${"la ".repeat(width / 3)}`.trimEnd();
  }).join("\n");

const setup = Effect.gen(function* () {
  const library = yield* fixtureLibrary;
  const dataDir = yield* temporaryDirectory("data");
  const context = yield* Layer.build(Layer.merge(layerMemory, testConfig(dataDir)));
  const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
  const libraryId = yield* control.addLibrary(library.root);
  const progress = yield* Ref.make<JobProgress>({ done: 0 });
  const releasedArt = yield* Ref.make(HashSet.empty<string>());

  const scan = scanLibrary({ id: libraryId, path: library.root }, progress, releasedArt).pipe(
    Effect.provideContext(context),
  );

  const trackAt = (path: string) =>
    control.tracks.pipe(
      Effect.map((tracks) => tracks.find((track) => track.scanned.path === path)),
    );

  /** The lyric sets stored for the song at `path`. */
  const lyricsAt = (path: string) =>
    trackAt(path).pipe(Effect.map((track) => track?.scanned.lyrics ?? []));

  /** What `lyrics.get` would answer for the song at `path` from its own lyrics. */
  const shownAt = (path: string) =>
    lyricsAt(path).pipe(
      Effect.map((sets) => resolveLyrics(sets, LyricsLookup.None(), { remoteLookups: "off" })),
    );

  const writeBytes = (path: string, bytes: Uint8Array) =>
    Files.writeFileAtomic(join(library.root, path), bytes, "x");

  const write = (path: string, text: string) => writeBytes(path, encoder.encode(text));

  /** The writes `run` made, as operation and paths. */
  const writesOf = <A, E>(run: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const before = (yield* control.writes).length;
      const result = yield* run;

      return { result, writes: (yield* control.writes).slice(before) };
    });

  return { ...library, control, scan, trackAt, lyricsAt, shownAt, write, writeBytes, writesOf };
});

/** A song's lyric file under its own name and a German one. */
const twoSidecarsOf = (song: string): ReadonlyArray<string> =>
  [".lrc", ".de.lrc"].map((name) => song.replace(/\.\w+$/u, name));

/** A one-second FLAC at `path` whose Vorbis `LYRICS` tag holds `lyrics`. */
const taggedFlac = (path: string, lyrics: string) =>
  runTool("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-metadata",
    `LYRICS=${lyrics}`,
    "-c:a",
    "flac",
    path,
  ]);

describe("scanLibrary lyrics", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("follows a lyric file as it is added, edited, and deleted, saving only lyrics", () =>
    runScoped(
      Effect.gen(function* () {
        const { scan, lyricsAt, shownAt, write, writesOf, root } = yield* setup;
        const sidecar = "Aurora Tones/Night Drive/01 Neon.lrc";

        yield* scan;
        expect(yield* lyricsAt(NEON)).toEqual([]);

        yield* write(sidecar, "[00:01.00]First line\n[00:02.50]Second line");
        const added = yield* writesOf(scan);

        expect(added.result).toMatchObject({ updated: 1, failed: 0 });
        expect(added.writes).toEqual([{ operation: "saveLocalLyrics", paths: [NEON] }]);
        expect(yield* shownAt(NEON)).toMatchObject({
          _tag: "Synced",
          source: "file",
          main: {
            kind: "main",
            lang: null,
            origin: { _tag: "Sidecar", fileName: "01 Neon.lrc", format: "lrc" },
            body: {
              lines: [
                { text: "First line", startMs: 1000 },
                { text: "Second line", startMs: 2500 },
              ],
            },
          },
        });
        expect(yield* scan).toMatchObject({ updated: 0 });

        yield* write(sidecar, "[00:01.00]First line\n[00:03.00]A longer second line");
        const edited = yield* writesOf(scan);

        expect(edited.writes).toEqual([{ operation: "saveLocalLyrics", paths: [NEON] }]);
        expect(yield* shownAt(NEON)).toMatchObject({
          main: { body: { lines: [{ text: "First line" }, { text: "A longer second line" }] } },
        });

        yield* Files.removePath(join(root, sidecar));
        const deleted = yield* writesOf(scan);

        expect(deleted.writes).toEqual([{ operation: "saveLocalLyrics", paths: [NEON] }]);
        expect(yield* lyricsAt(NEON)).toEqual([]);
        expect(yield* shownAt(NEON)).toEqual({ _tag: "None" });
      }),
    ));

  it("reads lyrics from tags, and shows a lyric file beside the song before them", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, lyricsAt, shownAt, write } = yield* setup;

        yield* Files.makeDirectory(join(root, "Tagged"));
        yield* taggedFlac(join(root, "Tagged/synced.flac"), "[00:01.00]From the tag");
        yield* taggedFlac(join(root, "Tagged/plain.flac"), "Just words\nMore words");
        yield* scan;

        expect(yield* shownAt("Tagged/synced.flac")).toMatchObject({
          _tag: "Synced",
          main: {
            origin: { _tag: "Embedded", tag: "vorbis:LYRICS" },
            body: { lines: [{ text: "From the tag", startMs: 1000 }] },
          },
          extras: [],
        });
        expect(yield* shownAt("Tagged/plain.flac")).toMatchObject({
          _tag: "Plain",
          main: { body: { _tag: "Plain", text: "Just words\nMore words" } },
        });

        yield* write("Tagged/synced.lrc", "[00:01.00]From the file");
        yield* scan;

        expect(yield* lyricsAt("Tagged/synced.flac")).toMatchObject([
          { origin: { _tag: "Sidecar", fileName: "synced.lrc" } },
          { origin: { _tag: "Embedded", tag: "vorbis:LYRICS" } },
        ]);
        expect(yield* shownAt("Tagged/synced.flac")).toMatchObject({
          _tag: "Synced",
          main: { origin: { _tag: "Sidecar" }, body: { lines: [{ text: "From the file" }] } },
          extras: [{ origin: { _tag: "Embedded" } }],
        });
      }),
    ));

  it("reads every song's lyrics once after an upgrade, leaving tags and artwork alone", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, scan, lyricsAt, write, writesOf } = yield* setup;

        yield* write("Aurora Tones/Night Drive/01 Neon.lrc", "[00:01.00]Kept");
        yield* scan;
        const before = yield* control.tracks;

        // Tracks a scan stored before it read lyrics have no lyrics reader.
        yield* control.forgetLyricsReader;
        const upgrade = yield* writesOf(scan);

        expect(upgrade.result).toEqual({ files: 10, updated: 10, moved: 0, missing: 0, failed: 0 });
        expect(upgrade.writes.map((call) => call.operation)).toEqual(["saveLocalLyrics"]);
        expect(upgrade.writes.flatMap((call) => call.paths).toSorted()).toEqual(
          before.map((track) => track.scanned.path).toSorted(),
        );
        expect(yield* control.tracks).toEqual(before);
        expect((yield* lyricsAt(NEON)).length).toBe(1);

        const after = yield* writesOf(scan);

        expect(after.result).toMatchObject({ updated: 0 });
        expect(after.writes).toEqual([]);
      }),
    ));

  it("keeps a moved song's lyrics, read from its new folder", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt, lyricsAt, write } = yield* setup;

        yield* write("Aurora Tones/Night Drive/01 Neon.lrc", "[00:01.00]Moving");
        yield* scan;
        const before = yield* trackAt(NEON);

        yield* Files.makeDirectory(join(root, "Moved"));
        yield* Files.renameFile(join(root, NEON), join(root, "Moved/Neon.mp3"));
        yield* Files.renameFile(
          join(root, "Aurora Tones/Night Drive/01 Neon.lrc"),
          join(root, "Moved/Neon.lrc"),
        );

        expect(yield* scan).toMatchObject({ moved: 1, missing: 0 });
        expect((yield* trackAt("Moved/Neon.mp3"))?.id).toBe(before?.id);
        expect(yield* lyricsAt("Moved/Neon.mp3")).toMatchObject([
          {
            origin: { _tag: "Sidecar", fileName: "Neon.lrc" },
            body: { lines: [{ text: "Moving" }] },
          },
        ]);
      }),
    ));

  it("stores nothing from lyric files it cannot read, and still scans every song", () =>
    runScoped(
      Effect.gen(function* () {
        const { scan, lyricsAt, write, writeBytes } = yield* setup;

        yield* writeBytes(
          "Aurora Tones/Night Drive/01 Neon.lrc",
          Uint8Array.of(0, 1, 2, 0, 255, 0),
        );
        yield* write("Aurora Tones/Night Drive/02 Overpass.ttml", "<tt><body><div><p>open");
        // Past the 256 KiB a lyric file may hold.
        yield* write("Aurora Tones/Night Drive/03 Doppelgänger.lrc", lrc(2000, 150));
        yield* write("Aurora Tones/First Light/01 Dawn.lrc", "[00:01.00]Readable");

        expect(yield* scan).toEqual({ files: 10, updated: 10, moved: 0, missing: 0, failed: 0 });
        expect(yield* lyricsAt(NEON)).toEqual([]);
        expect(yield* lyricsAt(OVERPASS)).toEqual([]);
        expect(yield* lyricsAt(DOPPELGANGER)).toEqual([]);
        expect(yield* lyricsAt(DAWN)).toMatchObject([{ body: { lines: [{ text: "Readable" }] } }]);

        // An unreadable lyric file is read again only once it changes.
        expect(yield* scan).toMatchObject({ updated: 0 });
      }),
    ));

  it("reads nothing through a lyric file that links out of the library, scan after scan", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, lyricsAt } = yield* setup;
        const outside = yield* temporaryDirectory("outside");

        yield* Files.writeFileAtomic(join(outside, "secret.lrc"), encoder.encode("[00:01]x"), "x");
        yield* Files.makeSymlink(
          join(outside, "secret.lrc"),
          join(root, "Aurora Tones/Night Drive/01 Neon.lrc"),
        );

        expect(yield* scan).toMatchObject({ updated: 10, failed: 0 });
        expect(yield* lyricsAt(NEON)).toEqual([]);
        expect(yield* scan).toMatchObject({ updated: 0, failed: 0 });
      }),
    ));

  it.skipIf(runsAsRoot())("reads a lyric file it cannot open again only once it changes", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, lyricsAt, write } = yield* setup;
        const locked = "Aurora Tones/Night Drive/02 Overpass.lrc";

        yield* write(locked, "[00:01.00]Locked away");
        yield* Effect.promise(() => makeUnreadable(join(root, locked)));

        expect(yield* scan).toMatchObject({ updated: 10, failed: 0 });
        expect(yield* lyricsAt(OVERPASS)).toEqual([]);
        expect(yield* scan).toMatchObject({ updated: 0, failed: 0 });

        yield* write(locked, "[00:01.00]Unlocked");
        expect(yield* scan).toMatchObject({ updated: 1 });
        expect(yield* lyricsAt(OVERPASS)).toMatchObject([
          { body: { lines: [{ text: "Unlocked" }] } },
        ]);
      }),
    ),
  );

  it("replaces or removes at most 2 MiB of stored lyrics in one write", () =>
    runScoped(
      Effect.gen(function* () {
        const { albums, control, root, scan, lyricsAt, write, writesOf } = yield* setup;
        const large = lrc(2000, 100);
        const songs = albums.flatMap((album) => album.tracks.map((track) => track.path));

        // About 700 KiB of lyric sets for each song.
        for (const song of songs) {
          for (const sidecar of twoSidecarsOf(song)) yield* write(sidecar, large);
        }

        yield* scan;

        const storedBytes = new Map(
          (yield* control.tracks).map((track) => [
            track.scanned.path,
            Buffer.byteLength(JSON.stringify(track.scanned.lyrics)),
          ]),
        );

        // Half the songs lose only their lyric files; the others change their audio too.
        for (const [index, song] of songs.entries()) {
          for (const sidecar of twoSidecarsOf(song)) yield* Files.removePath(join(root, sidecar));

          if (index % 2 === 1) {
            yield* Effect.promise(() => setFileTime(join(root, song), Date.now()));
          }
        }

        const { writes } = yield* writesOf(scan);

        expect(new Set(writes.map((batch) => batch.operation))).toEqual(
          new Set(["saveLocalLyrics", "upsertTracks"]),
        );
        expect(writes.flatMap((batch) => batch.paths).toSorted()).toEqual(songs.toSorted());

        for (const batch of writes) {
          const replaced = batch.paths.reduce(
            (bytes, path) => bytes + (storedBytes.get(path) ?? 0),
            0,
          );

          expect(replaced).toBeLessThanOrEqual(2 * 1024 * 1024);
        }

        for (const song of songs) expect(yield* lyricsAt(song)).toEqual([]);
      }),
    ));

  it("sends large lyrics in writes of at most 2 MiB, and keeps what fits of one song's", () =>
    runScoped(
      Effect.gen(function* () {
        const { albums, control, scan, lyricsAt, write, writesOf } = yield* setup;
        const large = lrc(2000, 100);
        const songs = albums.flatMap((album) => album.tracks.map((track) => track.path));

        // About 350 KiB of lyric sets each: seven of them are more than one write may send.
        for (const song of songs.slice(0, 7)) yield* write(song.replace(/\.\w+$/u, ".lrc"), large);

        // Three such files beside one song are more than Convex keeps for one.
        const crowded = songs[7] ?? "";

        for (const name of [".lrc", ".de.lrc", ".fr.lrc"]) {
          yield* write(crowded.replace(/\.\w+$/u, name), large);
        }

        const { writes } = yield* writesOf(scan);
        const stored = new Map((yield* control.tracks).map((track) => [track.scanned.path, track]));

        const sizes = writes.map((batch) =>
          batch.paths.reduce(
            (bytes, path) =>
              bytes + Buffer.byteLength(JSON.stringify(stored.get(path)?.scanned.lyrics ?? [])),
            0,
          ),
        );

        expect(writes.length).toBeGreaterThan(1);
        expect(new Set(writes.map((batch) => batch.operation))).toEqual(new Set(["upsertTracks"]));
        expect(writes.flatMap((batch) => batch.paths).toSorted()).toEqual(songs.toSorted());
        expect(Math.max(...sizes)).toBeLessThanOrEqual(2 * 1024 * 1024);
        const name = basename(crowded).replace(/\.\w+$/u, "");

        expect((yield* lyricsAt(crowded)).map((set) => set.origin)).toEqual([
          { _tag: "Sidecar", fileName: `${name}.lrc`, format: "lrc" },
          { _tag: "Sidecar", fileName: `${name}.de.lrc`, format: "lrc" },
        ]);
        expect(
          Buffer.byteLength(JSON.stringify(stored.get(crowded)?.scanned.lyrics ?? [])),
        ).toBeLessThanOrEqual(768 * 1024);
      }),
    ));
});
