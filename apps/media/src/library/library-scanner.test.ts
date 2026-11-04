import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import * as MediaTools from "../media/media-tools.ts";
import * as DiskCache from "../disk-cache.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Omdb from "../metadata/omdb.ts";
import * as Tmdb from "../metadata/tmdb.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { copyBytes } from "../testing/byte-copies.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as LibraryScanner from "./library-scanner.ts";
import * as MemoryLibrary from "./memory-library.ts";

const hasFfmpeg = await ffmpegAvailable();

const scannerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;

    const config = testConfigLayer({
      LIBRARY_ROOTS: workspace.root,
      DATA_DIR: path.join(workspace.root, "data"),
    });

    return LibraryScanner.layer.pipe(
      Layer.provideMerge(MemoryLibrary.layer),
      Layer.provide(MetadataResolver.layer),
      Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
      Layer.provide(Omdb.layerWithOptions(Omdb.defaultOptions(Option.none()))),
      Layer.provide(DiskCache.layer),
      Layer.provide(MediaTools.layer),
      Layer.provide(config),
    );
  }),
).pipe(
  Layer.provideMerge(FixtureWorkspace.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

const scanned = Effect.fn(function* (libraryId: LibraryId) {
  const library = yield* MemoryLibrary.Service;
  const files = yield* library.files(libraryId);

  return new Map(files.map((file) => [file.record.relativePath, file]));
});

describe.skipIf(!hasFfmpeg)("LibraryScanner", () => {
  layer(scannerLayer, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect("scans movies with probes, NFO metadata, artwork, and sidecar subtitles", () =>
      Effect.gen(function* () {
        const { library } = yield* FixtureWorkspace.Service;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("movies");

        const summary = yield* scanner.scan({
          libraryId,
          root: library.moviesRoot,
          mode: "incremental",
        });

        assert.deepStrictEqual([summary.discovered, summary.processed, summary.failed], [4, 4, 0]);
        const files = yield* scanned(libraryId);
        const direct = files.get(library.directMovie)?.record;

        assert.strictEqual(direct?.probe.container, "mp4");
        assert.strictEqual(direct?.probe.video?.codec, "h264");
        assert.strictEqual(direct?.probe.audio[0]?.codec, "aac");
        assert.strictEqual(direct?.title?.title, "Big Buck Fixture");
        assert.strictEqual(direct?.title?.plot, "A rabbit & a test pattern.");
        assert.deepStrictEqual(direct?.title?.genres, ["Animation", "Comedy"]);
        assert.deepStrictEqual(direct?.title?.ids, {
          tmdb: "10378",
          imdb: "tt1254207",
          tvdb: undefined,
        });
        assert.deepStrictEqual(direct?.title?.poster, {
          _tag: "Local",
          path: "Big Buck Fixture (2008)/poster.jpg",
        });
        assert.deepStrictEqual(direct?.title?.backdrop, {
          _tag: "Local",
          path: "Big Buck Fixture (2008)/fanart.jpg",
        });
        assert.deepStrictEqual(direct?.title?.sources, ["name", "nfo"]);

        const remux = files.get(library.remuxMovie)?.record;

        assert.strictEqual(remux?.probe.container, "mkv");
        assert.deepStrictEqual(
          remux?.probe.audio.map((track) => [track.codec, track.language, track.default]),
          [
            ["ac3", "eng", true],
            ["eac3", "fre", false],
          ],
        );
        assert.deepStrictEqual(
          remux?.probe.subtitles.map((track) => [track.codec, track.kind]),
          [["subrip", "text"]],
        );
        assert.deepStrictEqual(
          remux?.subtitles.map((subtitle) => [subtitle.format, subtitle.language, subtitle.forced]),
          [
            ["srt", "eng", false],
            ["ass", "fre", true],
          ],
        );
        assert.deepStrictEqual(remux?.title?.poster, {
          _tag: "Local",
          path: "Remux Fixture (2015)/folder.jpg",
        });

        const hdr = files.get(library.hdrMovie)?.record;

        assert.deepStrictEqual(
          [hdr?.probe.video?.codec, hdr?.probe.video?.bitDepth, hdr?.probe.video?.dynamicRange],
          ["hevc", 10, "hdr10"],
        );

        const messy = files.get(library.messyMovie)?.record;

        assert.deepStrictEqual(
          [messy?.title?.title, messy?.title?.year, messy?.title?.poster],
          ["Messy Release Name", 2012, undefined],
        );

        const progress = yield* (yield* MemoryLibrary.Service).progress(libraryId);

        assert.deepStrictEqual(
          progress.map((report) => report.phase),
          ["walking", "processing", "processing", "reconciling", "done"],
        );
      }),
    );

    it.effect("scans a show with seasons, specials, multi-episode files, and episode NFO", () =>
      Effect.gen(function* () {
        const { library } = yield* FixtureWorkspace.Service;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("shows");

        const summary = yield* scanner.scan({
          libraryId,
          root: library.showsRoot,
          mode: "incremental",
        });

        assert.strictEqual(summary.processed, library.episodes.length);
        const files = yield* scanned(libraryId);
        const record = (index: number) => files.get(library.episodes[index] ?? "")?.record;

        assert.strictEqual(record(0)?.title?.title, "Fixture Show");
        assert.strictEqual(record(0)?.title?.plot, "A show made of <colour bars>.");
        assert.deepStrictEqual(record(0)?.title?.poster, {
          _tag: "Local",
          path: "Fixture Show (2021)/poster.png",
        });
        assert.strictEqual(record(0)?.episode?.title, "Pilot (Local)");
        assert.strictEqual(record(0)?.episode?.airDate, "2021-01-01");
        assert.deepStrictEqual(record(0)?.episode?.still, {
          _tag: "Local",
          path: "Fixture Show (2021)/Season 01/Fixture Show - S01E01 - Pilot-thumb.jpg",
        });
        assert.deepStrictEqual(record(0)?.episode?.seasonPoster, {
          _tag: "Local",
          path: "Fixture Show (2021)/season01-poster.jpg",
        });
        assert.deepStrictEqual(record(2)?.episode?.episodes, [3, 4]);
        assert.strictEqual(record(3)?.episode?.title, "Return");
        assert.deepStrictEqual(record(3)?.episode?.seasonPoster, {
          _tag: "Local",
          path: "Fixture Show (2021)/Season 02/folder.jpg",
        });
        assert.deepStrictEqual(
          [record(4)?.episode?.season, record(4)?.episode?.episodes],
          [2, [2]],
        );
        assert.deepStrictEqual(
          [record(5)?.episode?.season, record(5)?.episode?.title],
          [0, "Special"],
        );
      }),
    );

    it.effect("skips unchanged files, rescans changed ones, and marks deleted ones missing", () =>
      Effect.gen(function* () {
        const { library, copy } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* copy;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("incremental");
        const request = { libraryId, root: target.movies, mode: "incremental" } as const;

        yield* scanner.scan(request);
        const again = yield* scanner.scan(request);

        assert.deepStrictEqual([again.unchanged, again.processed, again.missing], [4, 0, 0]);

        yield* fs.utimes(
          path.join(target.movies, library.messyMovie),
          new Date(),
          new Date(2001, 1, 1),
        );
        yield* fs.remove(path.join(target.movies, library.hdrMovie));
        const changed = yield* scanner.scan(request);

        assert.deepStrictEqual([changed.unchanged, changed.processed, changed.missing], [2, 1, 1]);
        const files = yield* scanned(libraryId);

        assert.isTrue(files.get(library.hdrMovie)?.missing);
        assert.isFalse(files.get(library.messyMovie)?.missing);

        const full = yield* scanner.scan({ ...request, mode: "full" });

        assert.deepStrictEqual([full.unchanged, full.processed], [0, 3]);
      }),
    );

    it.effect("rescans a file whose NFO, artwork, or subtitles changed", () =>
      Effect.gen(function* () {
        const { library, copy } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* copy;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("sidecars");
        const request = { libraryId, root: target.movies, mode: "incremental" } as const;
        const folder = path.join(target.movies, path.dirname(library.directMovie));

        yield* scanner.scan(request);

        const nfo = path.join(folder, "movie.nfo");
        const text = yield* fs.readFileString(nfo);

        yield* fs.writeFileString(nfo, text.replace("A rabbit &amp; a test pattern.", "Edited."));

        const edited = yield* scanner.scan(request);

        assert.deepStrictEqual([edited.processed, edited.unchanged], [1, 3]);
        assert.strictEqual(
          (yield* scanned(libraryId)).get(library.directMovie)?.record.title?.plot,
          "Edited.",
        );

        const again = yield* scanner.scan(request);

        assert.deepStrictEqual([again.processed, again.unchanged], [0, 4]);

        yield* fs.writeFileString(
          path.join(folder, `${path.basename(library.directMovie, ".mp4")}.de.srt`),
          "1\n00:00:01,000 --> 00:00:02,000\nHallo\n",
        );

        const subtitled = yield* scanner.scan(request);

        assert.deepStrictEqual([subtitled.processed, subtitled.unchanged], [1, 3]);

        yield* fs.makeDirectory(path.join(folder, ".actors"));
        yield* copyBytes(
          path.join(folder, "poster.jpg"),
          path.join(folder, ".actors/Big_Buck.jpg"),
        );

        const portrayed = yield* scanner.scan(request);

        assert.deepStrictEqual([portrayed.processed, portrayed.unchanged], [1, 3]);
      }),
    );

    it.effect("rescans only the films a companion in a shared folder belongs to", () =>
      Effect.gen(function* () {
        const { library, copy } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* copy;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("shared-folder");
        const folder = path.join(target.movies, "Shared");
        const source = path.join(target.movies, library.messyMovie);
        const request = { libraryId, root: target.movies, mode: "incremental" } as const;

        yield* fs.makeDirectory(folder);

        for (const film of ["Alpha (2001)", "Alpha (2001)-Beta (2002)", "Gamma (2003)"]) {
          yield* copyBytes(source, path.join(folder, `${film}.mkv`));
        }

        yield* scanner.scan(request);

        const rescanned = Effect.fn(function* (companion: string) {
          yield* fs.writeFileString(path.join(folder, companion), "1\n");
          const summary = yield* scanner.scan(request);

          return summary.processed;
        });

        assert.strictEqual(yield* rescanned("Gamma (2003).en.srt"), 1);
        assert.strictEqual(yield* rescanned("Alpha (2001)-Beta (2002).en.srt"), 2);
        assert.strictEqual(yield* rescanned("folder.jpg"), 3);
      }),
    );

    it.effect("treats a folder of one movie's editions as that movie's own folder", () =>
      Effect.gen(function* () {
        const { library, copy } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* copy;
        const scanner = yield* LibraryScanner.Service;
        const libraryId = LibraryId.make("editions");
        const folder = "Edition Fixture (2001)";
        const source = path.join(target.movies, library.directMovie);

        yield* fs.makeDirectory(path.join(target.movies, folder));

        for (const edition of ["Theatrical", "Director's Cut"]) {
          yield* copyBytes(
            source,
            path.join(target.movies, folder, `${folder} {edition-${edition}}.mp4`),
          );
        }

        yield* copyBytes(
          path.join(path.dirname(source), "poster.jpg"),
          path.join(target.movies, folder, "poster.jpg"),
        );
        yield* fs.writeFileString(
          path.join(target.movies, folder, "movie.nfo"),
          "<movie><title>Edition Fixture</title><plot>Two cuts, one film.</plot></movie>",
        );

        yield* scanner.scan({ libraryId, root: target.movies, mode: "incremental" });

        const files = yield* scanned(libraryId);

        const editions = [...files.values()].filter((file) =>
          file.record.relativePath.startsWith(`${folder}/`),
        );

        assert.strictEqual(editions.length, 2);

        for (const edition of editions) {
          assert.strictEqual(edition.record.title?.plot, "Two cuts, one film.");
          assert.deepStrictEqual(edition.record.title?.poster, {
            _tag: "Local",
            path: `${folder}/poster.jpg`,
          });
        }

        yield* fs.writeFileString(
          path.join(target.movies, folder, `${folder} {edition-Theatrical}.en.srt`),
          "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
        );

        const subtitled = yield* scanner.scan({
          libraryId,
          root: target.movies,
          mode: "incremental",
        });

        assert.strictEqual(subtitled.processed, 1);

        const anthology = "Anthology (2020)";

        yield* fs.makeDirectory(path.join(target.movies, anthology));

        for (const film of ["Film A (2018)", "Film B (2019)"]) {
          yield* copyBytes(source, path.join(target.movies, anthology, `${film}.mp4`));
        }

        yield* fs.writeFileString(
          path.join(target.movies, anthology, "movie.nfo"),
          "<movie><title>Anthology</title><plot>Not about either film.</plot></movie>",
        );
        yield* scanner.scan({ libraryId, root: target.movies, mode: "incremental" });

        const films = [...(yield* scanned(libraryId)).values()].filter((file) =>
          file.record.relativePath.startsWith(`${anthology}/`),
        );

        assert.deepStrictEqual(
          films.map((file) => file.record.title?.plot),
          [undefined, undefined],
        );
      }),
    );

    it.effect(
      "follows links inside the root, rejects links that escape it, and visits loops once",
      () =>
        Effect.gen(function* () {
          const { library, copy } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const target = yield* copy;
          const outside = path.join(target.root, "outside.mkv");

          yield* copyBytes(path.join(target.movies, library.messyMovie), outside);
          yield* fs.symlink(outside, path.join(target.movies, "Escaped (2000).mkv"));
          yield* fs.symlink(
            path.join(target.movies, "Big Buck Fixture (2008)"),
            path.join(target.movies, "Linked"),
          );
          yield* fs.symlink(
            target.movies,
            path.join(target.movies, "Remux Fixture (2015)", "loop"),
          );

          const leakedNfo = path.join(target.root, "leaked.nfo");

          yield* fs.writeFileString(
            leakedNfo,
            "<movie><title>Leaked Title</title><year>2012</year></movie>",
          );

          yield* fs.symlink(
            leakedNfo,
            path.join(target.movies, library.messyMovie.replace(/\.mkv$/u, ".nfo")),
          );

          const scanner = yield* LibraryScanner.Service;
          const libraryId = LibraryId.make("links");

          const summary = yield* scanner.scan({
            libraryId,
            root: target.movies,
            mode: "incremental",
          });

          const files = yield* scanned(libraryId);

          assert.strictEqual(summary.rejectedLinks, 2);
          assert.isFalse(files.has("Escaped (2000).mkv"));
          assert.strictEqual(
            files.get(library.messyMovie)?.record.title?.title,
            "Messy Release Name",
          );
          assert.strictEqual(summary.discovered, 4);
        }),
    );

    it.effect(
      "refuses unapproved roots, writes nothing, and keeps known files when a root is unavailable",
      () =>
        Effect.gen(function* () {
          const { copy, root } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const target = yield* copy;
          const scanner = yield* LibraryScanner.Service;
          const libraryId = LibraryId.make("unavailable");

          const unapproved = yield* scanner
            .scan({ libraryId, root: path.dirname(root), mode: "incremental" })
            .pipe(Effect.flip);

          assert.instanceOf(unapproved, LibraryScanner.LibraryRootNotApproved);

          const missingRoot = yield* scanner
            .scan({ libraryId, root: path.join(target.root, "unmounted"), mode: "incremental" })
            .pipe(Effect.flip);

          assert.instanceOf(missingRoot, LibraryScanner.LibraryRootUnavailable);
          assert.strictEqual(
            missingRoot instanceof LibraryScanner.LibraryRootUnavailable && missingRoot.reason,
            "missing",
          );

          const before = yield* fs.readDirectory(target.movies, { recursive: true });
          yield* scanner.scan({ libraryId, root: target.movies, mode: "incremental" });
          const after = yield* fs.readDirectory(target.movies, { recursive: true });

          assert.deepStrictEqual(after.toSorted(), before.toSorted());

          yield* fs.remove(target.movies, { recursive: true });
          yield* fs.makeDirectory(target.movies);

          const empty = yield* scanner
            .scan({ libraryId, root: target.movies, mode: "incremental" })
            .pipe(Effect.flip);

          assert.strictEqual(
            empty instanceof LibraryScanner.LibraryRootUnavailable && empty.reason,
            "empty",
          );
          const files = yield* scanned(libraryId);

          assert.strictEqual(files.size, 4);
          assert.isTrue([...files.values()].every((file) => !file.missing));
        }),
    );
  });
});
