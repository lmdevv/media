import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect, Layer, Ref } from "effect";

import { artPath, imageContentType } from "./art-store.ts";
import { runTool } from "./ffmpeg.ts";
import * as Files from "./files.ts";
import type { JobProgress } from "./media-backend.ts";
import { LibraryEmpty, LibraryUnavailable, scanLibrary } from "./scan.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  temporaryDirectory,
  testConfig,
} from "./testing/fixtures.ts";
import { layerMemory, MemoryMediaBackendControl } from "./testing/memory-media-backend.ts";
import { makeReadable, makeUnreadable, runsAsRoot } from "./testing/permissions.ts";
import { runScoped } from "./testing/run.ts";

const setup = Effect.gen(function* () {
  const library = yield* fixtureLibrary;
  const dataDir = yield* temporaryDirectory("data");
  const context = yield* Layer.build(Layer.merge(layerMemory, testConfig(dataDir)));
  const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
  const libraryId = yield* control.addLibrary(library.root);
  const progress = yield* Ref.make<JobProgress>({ done: 0 });

  const scan = scanLibrary({ id: libraryId, path: library.root }, progress).pipe(
    Effect.provideContext(context),
  );

  const trackAt = (path: string) =>
    control.tracks.pipe(
      Effect.map((tracks) => tracks.find((track) => track.scanned.path === path)),
    );

  return { ...library, dataDir, control, progress, scan, trackAt };
});

describe("scanLibrary", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("reads tags, formats, and artwork from every fixture and skips what is not music", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, albums, dataDir, control, progress, scan, trackAt } = yield* setup;
        const summary = yield* scan;

        expect(summary).toEqual({ files: 10, updated: 10, moved: 0, missing: 0, failed: 0 });
        expect(yield* Ref.get(progress)).toMatchObject({ done: 10, total: 10 });
        const tracks = yield* control.tracks;

        expect(tracks.map((track) => track.scanned.path).toSorted()).toEqual(
          albums.flatMap((album) => album.tracks.map((track) => track.path)).toSorted(),
        );

        const dawn = yield* trackAt("Aurora Tones/First Light/01 Dawn.flac");

        expect(dawn?.scanned).toMatchObject({
          title: "Dawn",
          artist: "Aurora Tones",
          albumArtist: "Aurora Tones",
          album: "First Light",
          trackNumber: 1,
          discNumber: 1,
          year: 2021,
          genre: "Ambient",
          codec: "flac",
          lossless: true,
          bitDepth: 16,
          sampleRate: 44_100,
        });

        expect(dawn?.scanned.durationMs).toBeGreaterThan(3900);
        expect(dawn?.scanned.durationMs).toBeLessThan(4100);

        const hiRes = yield* trackAt("The Sine Waves/Harmonics/01 Fundamental.flac");

        expect(hiRes?.scanned).toMatchObject({
          codec: "flac",
          lossless: true,
          bitDepth: 24,
          sampleRate: 96_000,
        });

        const mp3 = yield* trackAt("Aurora Tones/Night Drive/01 Neon.mp3");

        expect(mp3?.scanned).toMatchObject({
          codec: "mp3",
          lossless: false,
          bitrate: 320_000,
          year: 2023,
        });

        const m4a = yield* trackAt("The Sine Waves/Folder Art/01 Brushes.m4a");

        expect(m4a?.scanned).toMatchObject({
          codec: "aac",
          lossless: false,
          album: "Folder Art",
          trackNumber: 1,
        });

        // Embedded covers: one image per album, stored once under its hash.
        const morning = yield* trackAt("Aurora Tones/First Light/02 Morning Haze.flac");
        const embedded = dawn?.scanned.artHash ?? "";

        expect(embedded).toMatch(/^[0-9a-f]{64}$/);
        expect(morning?.scanned.artHash).toBe(embedded);
        expect(imageContentType(yield* Files.readHead(artPath(dataDir, embedded), 16))).toBe(
          "image/png",
        );
        expect(
          imageContentType(yield* Files.readHead(artPath(dataDir, mp3?.scanned.artHash ?? ""), 16)),
        ).toBe("image/jpeg");

        // Folder art: the album without embedded pictures uses its cover.jpg.
        const cover = yield* Files.readWholeFile(join(root, "The Sine Waves/Folder Art/cover.jpg"));

        expect(m4a?.scanned.artHash).toBe(createHash("sha256").update(cover).digest("hex"));
        expect(yield* Files.readWholeFile(artPath(dataDir, m4a?.scanned.artHash ?? ""))).toEqual(
          cover,
        );
      }),
    ));

  it("skips unchanged files, marks deleted ones missing, and restores them", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;
        const path = "Aurora Tones/Night Drive/02 Overpass.mp3";

        yield* scan;
        expect(yield* scan).toEqual({ files: 10, updated: 0, moved: 0, missing: 0, failed: 0 });

        const bytes = yield* Files.readWholeFile(join(root, path));
        yield* Files.removePath(join(root, path));
        expect(yield* scan).toEqual({ files: 9, updated: 0, moved: 0, missing: 1, failed: 0 });
        expect((yield* trackAt(path))?.missing).toBe(true);

        yield* Files.writeFileAtomic(join(root, path), bytes, "restore");
        expect(yield* scan).toEqual({ files: 10, updated: 1, moved: 0, missing: 0, failed: 0 });
        expect((yield* trackAt(path))?.missing).toBe(false);
      }),
    ));

  it("keeps the identity of songs that were renamed or moved to another folder", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;
        const renamed = "Aurora Tones/First Light/01 Dawn.flac";
        const album = "Aurora Tones/Night Drive";

        yield* scan;
        const dawn = yield* trackAt(renamed);
        const neon = yield* trackAt(`${album}/01 Neon.mp3`);
        const overpass = yield* trackAt(`${album}/02 Overpass.mp3`);

        yield* Files.renameFile(
          join(root, renamed),
          join(root, "Aurora Tones/First Light/Dawn.flac"),
        );
        yield* Files.makeDirectory(join(root, "Moved"));
        yield* Files.renameFile(join(root, album), join(root, "Moved/Night Drive"));

        // Dawn, and the three songs of Night Drive.
        expect(yield* scan).toEqual({ files: 10, updated: 0, moved: 4, missing: 0, failed: 0 });
        expect((yield* trackAt("Aurora Tones/First Light/Dawn.flac"))?.id).toBe(dawn?.id);
        expect((yield* trackAt("Moved/Night Drive/01 Neon.mp3"))?.id).toBe(neon?.id);
        expect((yield* trackAt("Moved/Night Drive/02 Overpass.mp3"))?.id).toBe(overpass?.id);
        expect(yield* trackAt(renamed)).toBeUndefined();
        expect(yield* scan).toEqual({ files: 10, updated: 0, moved: 0, missing: 0, failed: 0 });
      }),
    ));

  it("keeps the identity of a renamed untagged song whose title comes from its name", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;

        yield* runTool("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=330:duration=2",
          "-map_metadata",
          "-1",
          "-c:a",
          "libmp3lame",
          join(root, "take one.mp3"),
        ]);

        yield* scan;
        const before = yield* trackAt("take one.mp3");

        yield* Files.renameFile(join(root, "take one.mp3"), join(root, "final take.mp3"));

        expect(yield* scan).toMatchObject({ moved: 1, missing: 0 });
        expect(yield* trackAt("final take.mp3")).toMatchObject({
          id: before?.id,
          missing: false,
          scanned: { title: "final take" },
        });
      }),
    ));

  it("treats a copy as a new song, and does not guess between identical songs", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, control, scan, trackAt } = yield* setup;
        const dawn = "Aurora Tones/First Light/01 Dawn.flac";

        yield* Files.copyTree(join(root, dawn), join(root, "Dawn copy.flac"));
        yield* Files.copyTree(join(root, dawn), join(root, "Dawn again.flac"));
        yield* scan;
        const tracks = (yield* control.tracks).length;

        // The original stays, so its copy is a song of its own.
        yield* Files.copyTree(join(root, dawn), join(root, "Third Dawn.flac"));
        expect(yield* scan).toMatchObject({ updated: 1, moved: 0 });
        expect(yield* control.tracks).toHaveLength(tracks + 1);

        // Two identical songs gone and one found: it could be either, so it is new.
        yield* Files.removePath(join(root, "Dawn copy.flac"));
        yield* Files.removePath(join(root, "Dawn again.flac"));
        yield* Files.removePath(join(root, "Third Dawn.flac"));
        yield* Files.copyTree(join(root, dawn), join(root, "Last Dawn.flac"));
        expect(yield* scan).toMatchObject({ updated: 1, moved: 0, missing: 3 });
        expect((yield* trackAt("Dawn copy.flac"))?.missing).toBe(true);
      }),
    ));

  it("falls back to the file and folder names for untagged files and skips unreadable ones", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;

        yield* Files.makeDirectory(join(root, "Loose"));
        yield* runTool("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=330:duration=2",
          "-map_metadata",
          "-1",
          "-c:a",
          "libmp3lame",
          join(root, "Loose", "untitled take.mp3"),
        ]);

        yield* Files.writeFileAtomic(
          join(root, "Loose", "broken.flac"),
          new TextEncoder().encode("not audio"),
          "x",
        );
        expect(yield* scan).toEqual({ files: 12, updated: 11, moved: 0, missing: 0, failed: 1 });

        expect((yield* trackAt("Loose/untitled take.mp3"))?.scanned).toMatchObject({
          title: "untitled take",
          artist: "Unknown Artist",
          album: "Loose",
          codec: "mp3",
        });

        expect(yield* trackAt("Loose/broken.flac")).toBeUndefined();
      }),
    ));

  it("follows symlinks that stay inside the library and skips ones that leave it", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, control, scan, trackAt } = yield* setup;
        const outside = yield* temporaryDirectory("outside");
        const dawn = "Aurora Tones/First Light/01 Dawn.flac";
        const folderArt = join(root, "The Sine Waves", "Folder Art");

        yield* Files.copyTree(join(root, dawn), join(outside, "secret.flac"));
        yield* Files.copyTree(join(folderArt, "cover.jpg"), join(outside, "cover.jpg"));
        yield* Files.makeSymlink(join(outside, "secret.flac"), join(root, "escape.flac"));
        yield* Files.makeSymlink(outside, join(root, "Elsewhere"));
        yield* Files.makeSymlink(root, join(root, "Loop"));
        yield* Files.makeSymlink(join(root, dawn), join(root, "inside.flac"));

        // A folder whose only artwork is a link to an image outside the library.
        yield* Files.makeDirectory(join(root, "Bare"));
        yield* Files.copyTree(join(folderArt, "01 Brushes.m4a"), join(root, "Bare", "song.m4a"));
        yield* Files.makeSymlink(join(outside, "cover.jpg"), join(root, "Bare", "cover.jpg"));

        expect(yield* scan).toEqual({ files: 12, updated: 12, moved: 0, missing: 0, failed: 0 });

        const paths = (yield* control.tracks).map((track) => track.scanned.path);

        expect(paths).toContain("inside.flac");
        expect(paths).not.toContain("escape.flac");
        expect(paths).not.toContain("Elsewhere/secret.flac");
        expect(paths.filter((path) => path.startsWith("Loop/"))).toEqual([]);
        expect((yield* trackAt("Bare/song.m4a"))?.scanned.artHash).toBeUndefined();
      }),
    ));

  it("reads songs again when their folder's cover is replaced", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;
        const path = "The Sine Waves/Folder Art/01 Brushes.m4a";

        yield* scan;
        const before = (yield* trackAt(path))?.scanned.artHash;

        // Another JPEG: the art store only checks an image's first bytes.
        const replaced = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]);

        yield* Files.writeFileAtomic(
          join(root, "The Sine Waves/Folder Art/cover.jpg"),
          replaced,
          "x",
        );
        const summary = yield* scan;
        const after = (yield* trackAt(path))?.scanned.artHash;

        // Both songs of the album, Brushes and Walking Bass.
        expect(summary).toMatchObject({ updated: 2, missing: 0, failed: 0 });
        expect(after).toBe(createHash("sha256").update(replaced).digest("hex"));
        expect(after).not.toBe(before);
        expect(yield* scan).toMatchObject({ updated: 0 });
      }),
    ));

  it("gives songs in disc folders the album folder's cover", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;
        const source = join(root, "The Sine Waves/Folder Art");
        const album = join(root, "Boxed Set");

        for (const folder of ["CD1", "Disc 2", "Extras"]) {
          yield* Files.makeDirectory(join(album, folder));
          yield* Files.copyTree(join(source, "01 Brushes.m4a"), join(album, folder, "song.m4a"));
        }

        yield* Files.copyTree(join(source, "cover.jpg"), join(album, "cover.jpg"));
        yield* scan;

        const cover = createHash("sha256")
          .update(yield* Files.readWholeFile(join(album, "cover.jpg")))
          .digest("hex");

        expect((yield* trackAt("Boxed Set/CD1/song.m4a"))?.scanned.artHash).toBe(cover);
        expect((yield* trackAt("Boxed Set/Disc 2/song.m4a"))?.scanned.artHash).toBe(cover);
        expect((yield* trackAt("Boxed Set/Extras/song.m4a"))?.scanned.artHash).toBeUndefined();
      }),
    ));

  it("stores only images as artwork", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, trackAt } = yield* setup;
        const folder = join(root, "The Sine Waves", "Folder Art");

        yield* Files.writeFileAtomic(
          join(folder, "cover.jpg"),
          new TextEncoder().encode("<html><script>alert(1)</script></html>"),
          "x",
        );

        yield* scan;
        expect((yield* trackAt("The Sine Waves/Folder Art/01 Brushes.m4a"))?.scanned.artHash).toBe(
          undefined,
        );
      }),
    ));

  it.skipIf(runsAsRoot())(
    "fails instead of marking songs missing when a folder becomes unreadable",
    () =>
      runScoped(
        Effect.gen(function* () {
          const { root, scan, trackAt } = yield* setup;
          const folder = join(root, "Aurora Tones", "Night Drive");
          const path = "Aurora Tones/Night Drive/02 Overpass.mp3";

          yield* scan;
          yield* Effect.promise(() => makeUnreadable(folder));
          yield* Effect.addFinalizer(() => Effect.promise(() => makeReadable(folder)));

          const error = yield* Effect.flip(scan);

          expect(error).toBeInstanceOf(LibraryUnavailable);
          expect(error.message).toContain(`Can't read ${folder}: permission denied`);
          expect((yield* trackAt(path))?.missing).toBe(false);
        }),
      ),
  );

  it.skipIf(runsAsRoot())("skips an unreadable lost+found folder at the library root", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan } = yield* setup;
        const lostAndFound = join(root, "lost+found");

        yield* Files.makeDirectory(lostAndFound);
        yield* Effect.promise(() => makeUnreadable(lostAndFound));
        yield* Effect.addFinalizer(() => Effect.promise(() => makeReadable(lostAndFound)));

        expect(yield* scan).toMatchObject({ missing: 0, failed: 0 });
      }),
    ),
  );

  it("fails instead of marking every song missing when the folder is empty", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, control, scan } = yield* setup;

        yield* scan;
        // An unmounted share: the mount point is there and reads fine, with nothing in it.

        for (const name of yield* Files.listNames(root)) yield* Files.removePath(join(root, name));

        const error = yield* Effect.flip(scan);

        expect(error).toBeInstanceOf(LibraryEmpty);
        expect(error.message).toBe(
          `The folder is empty. Is the drive mounted? (${root}) If its music was removed on purpose, delete the library.`,
        );
        expect((yield* control.tracks).filter((track) => track.missing)).toEqual([]);
      }),
    ));

  it("scans an empty folder for a library without songs", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");
        const empty = yield* temporaryDirectory("library");
        const context = yield* Layer.build(Layer.merge(layerMemory, testConfig(dataDir)));
        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const libraryId = yield* control.addLibrary(empty);
        const progress = yield* Ref.make<JobProgress>({ done: 0 });

        expect(
          yield* scanLibrary({ id: libraryId, path: empty }, progress).pipe(
            Effect.provideContext(context),
          ),
        ).toMatchObject({ files: 0, missing: 0 });
      }),
    ));

  it("fails with LibraryUnavailable when the folder is missing", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");
        const context = yield* Layer.build(Layer.merge(layerMemory, testConfig(dataDir)));
        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const missing = join(dataDir, "nowhere");
        const libraryId = yield* control.addLibrary(missing);
        const progress = yield* Ref.make<JobProgress>({ done: 0 });

        const error = yield* scanLibrary({ id: libraryId, path: missing }, progress).pipe(
          Effect.provideContext(context),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(LibraryUnavailable);
        expect(error.message).toContain(missing);
      }),
    ));
});
