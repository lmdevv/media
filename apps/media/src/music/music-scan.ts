/**
 * Music's scan, as old music's media service ran it (`scan.ts`): walk each of the library's
 * folders, compare what is there with what the core knows, read the tags, artwork, and lyrics of
 * new and changed files, follow files that moved, and mark the ones that went missing. It writes
 * only through a `ScanCatalog`, which the scan job builds over the core's music scanner functions
 * under its lease, so a canceled or replaced attempt writes nothing (ADR 0024).
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

import type { KnownTrack, ScannedLyrics, ScannedTrack } from "@media/contracts/models/music";
import { MUSIC_FINGERPRINT_MAX } from "@media/contracts/models/music";
import { Cache, Effect, HashSet, Option, Ref, Schema, Stream } from "effect";

import { saveArt } from "./art-store.ts";
import { extensionOf, isAudioFile } from "./audio-format.ts";
import { folderArtKey, folderArtLookup, isFolderArt } from "./folder-art.ts";
import { isLyricsSidecar, lyricsFilesKey, lyricsSidecarMatcher } from "./lyrics/sidecars.ts";
import type { LyricsSidecar } from "./lyrics/sidecars.ts";
import { movedFileMatcher } from "./moved-files.ts";
import * as Files from "./music-files.ts";
import type { WalkedFile } from "./music-files.ts";
import { readTagLyrics, readTrackTags } from "./tag-reader.ts";
import { LYRICS_READER_VERSION, readTrackLyrics } from "./track-lyrics.ts";

/** The artist a scan names for a file whose tags name none. */
const UNKNOWN_ARTIST = "Unknown Artist";

/** The album a scan names for a file at the top of a folder whose tags name none. */
const UNKNOWN_ALBUM = "Unknown Album";

const READ_BATCH = 100;

const BATCH_LYRICS_BYTES = 2 * 1024 * 1024;

const MISSING_BATCH = 200;

const TAG_CONCURRENCY = 8;

const KNOWN_RANGE = 800;

const KNOWN_CONCURRENCY = 4;

/** A library folder is missing or is not a readable folder. Its songs are left as they are. */
export class LibraryUnavailable extends Schema.TaggedError<LibraryUnavailable>()(
  "LibraryUnavailable",
  { folder: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * A library folder holds no audio files while the core knows songs in it: most likely a network
 * share or a drive that is not mounted, whose empty mount point reads fine. The scan stops
 * without marking anything missing, as old music's did. Losing every song to an unmounted drive
 * is worse than keeping songs that were all deleted on purpose, which removing the folder clears.
 */
export class LibraryEmpty extends Schema.TaggedError<LibraryEmpty>()("LibraryEmpty", {
  folder: Schema.String,
}) {
  override get message(): string {
    return (
      `The folder is empty. Is the drive mounted? (${this.folder}) ` +
      "If its music was removed on purpose, remove the folder from the library."
    );
  }
}

/** A library's paths from `from` up to, not including, `to`; open where absent. */
export interface PathRange {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** A track found at a new path, and the path it was known at. */
export interface TrackMove {
  readonly from: string;
  readonly track: ScannedTrack;
}

/**
 * Where a scan writes: the core's music scanner functions under the scan's lease. Each write takes
 * any number of items and sends them on until the core committed every one.
 */
export interface ScanCatalog<E> {
  /** Every track the library lists inside its folders now in `range`, missing ones included. */
  readonly known: (range: PathRange) => Effect.Effect<ReadonlyArray<KnownTrack>, E>;
  /** Writes new and changed files; answers the artwork the writes stopped using somewhere. */
  readonly upsert: (tracks: ReadonlyArray<ScannedTrack>) => Effect.Effect<ReadonlyArray<string>, E>;
  /** Moves tracks to their new paths, keeping their ids; answers how many moved and released art. */
  readonly move: (
    moves: ReadonlyArray<TrackMove>,
  ) => Effect.Effect<{ readonly moved: number; readonly released: ReadonlyArray<string> }, E>;
  /** Marks paths missing, keeping their rows; answers the artwork that released. */
  readonly missing: (paths: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, E>;
  /** Saves the lyrics read again for files whose audio did not change. */
  readonly lyrics: (tracks: ReadonlyArray<ScannedLyrics>) => Effect.Effect<void, E>;
}

/** What a scan reports while it runs. */
export interface ScanProgress {
  readonly done: number;
  readonly total: number | null;
  readonly message: string;
}

/** Counts from a finished scan. */
export interface ScanSummary {
  readonly files: number;
  /** New and changed files read and stored, besides the moved ones. */
  readonly updated: number;
  /** Files found at a new path whose track moved with them. */
  readonly moved: number;
  readonly missing: number;
  readonly failed: number;
}

/** A one-line description of a scan result for the jobs list, as old music wrote it. */
export const describeScan = (summary: ScanSummary): string => {
  const parts = [`${summary.files} files`, `${summary.updated} updated`];

  if (summary.moved > 0) parts.push(`${summary.moved} moved`);
  parts.push(`${summary.missing} missing`);

  if (summary.failed > 0) parts.push(`${summary.failed} unreadable`);

  return parts.join(", ");
};

const codePointRank = (unit: number): number =>
  unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;

/**
 * Orders text by code point, as Convex orders index keys, rather than by UTF-16 unit as `<` and
 * `Array.prototype.sort` do: the two disagree when one string has a character beyond U+FFFF where
 * the other has one from U+E000 to U+FFFF.
 */
const compareText = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);

  for (let position = 0; position < length; position += 1) {
    const leftUnit = left.charCodeAt(position);
    const rightUnit = right.charCodeAt(position);

    if (leftUnit !== rightUnit) return codePointRank(leftUnit) - codePointRank(rightUnit);
  }

  return left.length - right.length;
};

/**
 * Splits a library's paths into ranges holding about `size` of `paths` each, in the code point
 * order the core keeps them in. The first range is open below and the last open above, so every
 * path the core knows, found on disk or not, falls in exactly one range.
 */
export const pathRanges = (
  paths: ReadonlyArray<string>,
  size: number,
): ReadonlyArray<PathRange> => {
  const sorted = paths.toSorted(compareText);
  const bounds = sorted.filter((_, index) => index > 0 && index % size === 0);

  return [undefined, ...bounds].map((from, index) => ({ from, to: bounds[index] }));
};

const HASHED = 1 + 64;

const DANGLING = /[\uD800-\uDBFF]$/u;

/**
 * A fingerprint as the core keeps it (`fingerprint` in `music/fit.ts`): itself when it is at most
 * `MUSIC_FINGERPRINT_MAX` long, else its leading part, `#`, and the hex SHA-256 of the whole, so
 * a scan compares what it reads with what `known` answers and a rescan rewrites nothing that did
 * not change.
 */
export const storedFingerprint = (text: string): string => {
  if (text.length <= MUSIC_FINGERPRINT_MAX) return text;

  const kept = text.slice(0, MUSIC_FINGERPRINT_MAX - HASHED);
  const lead = DANGLING.test(kept) ? kept.slice(0, -1) : kept;

  return `${lead}#${createHash("sha256").update(text).digest("hex")}`;
};

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const byLyricsSize = <A>(
  items: ReadonlyArray<A>,
  lyricsBytesOf: (item: A) => number,
): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<Array<A>> = [];
  let bytes = 0;

  for (const item of items) {
    const size = lyricsBytesOf(item);
    const last = batches.at(-1);

    if (last === undefined || bytes + size > BATCH_LYRICS_BYTES) {
      batches.push([item]);
      bytes = size;
    } else {
      last.push(item);
      bytes += size;
    }
  }

  return batches;
};

/** A value being built field by field before it is handed on as `Value`. */
type Draft<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** An audio file a walk found, at its absolute path in one of the library's folders. */
interface FoundFile extends WalkedFile {
  readonly folder: string;
  readonly path: string;
}

/** What one folder's walk found besides its audio: its artwork and lyric files. */
interface FolderFiles {
  readonly artFor: (relativeFolder: string) => WalkedFile | undefined;
  readonly sidecarsOf: (relativePath: string) => ReadonlyArray<LyricsSidecar>;
}

/** A file found on disk that the core does not have as it is now, and what to read of it. */
interface Pending {
  /** `file`: its tags, art, and lyrics. `lyrics`: only its lyrics, the rest is unchanged. */
  readonly read: "file" | "lyrics";
  readonly file: FoundFile;
}

/** What reading a pending file found. */
type Read =
  | { readonly read: "file"; readonly track: ScannedTrack }
  | { readonly read: "lyrics"; readonly lyrics: ScannedLyrics };

const readNeeded = (
  known: KnownTrack | undefined,
  file: { readonly size: number; readonly mtimeMs: number },
  folderArt: string | undefined,
  lyricsFiles: string,
): Pending["read"] | null => {
  if (
    known === undefined ||
    known.missing ||
    known.size !== file.size ||
    known.mtimeMs !== file.mtimeMs ||
    known.folderArt !== (folderArt === undefined ? null : storedFingerprint(folderArt))
  ) {
    return "file";
  }

  return known.lyricsFiles === storedFingerprint(lyricsFiles) &&
    known.lyricsReader === LYRICS_READER_VERSION
    ? null
    : "lyrics";
};

const walkFolder = (libraryId: string, folder: string) =>
  Files.walkTree(
    folder,
    (name) => isAudioFile(name) || isFolderArt(name) || isLyricsSidecar(name),
  ).pipe(
    Effect.mapError(
      (error) =>
        new LibraryUnavailable({
          folder,
          reason: error.missing
            ? `Library folder unavailable: ${folder}`
            : Files.walkFailureOf(error),
        }),
    ),
    Effect.annotateLogs({ libraryId }),
  );

/**
 * Reads every known track, range by range, so a large library's pages are read side by side, as
 * old music read its fingerprints.
 */
const knownTracks = <E>(catalog: ScanCatalog<E>, paths: ReadonlyArray<string>) =>
  Effect.forEach(pathRanges(paths, KNOWN_RANGE), catalog.known, {
    concurrency: KNOWN_CONCURRENCY,
  }).pipe(Effect.map((ranges) => new Map(ranges.flat().map((file) => [file.path, file]))));

/**
 * Scans the library `libraryId` in `folders`, writing through `catalog`, reporting into
 * `progress` as it goes, and adding the artwork each write stopped using somewhere to
 * `releasedArt` as soon as the write lands, so it counts even when the scan fails or is canceled
 * later. Unreadable files are skipped and counted; they are read again on the next scan because
 * the core never learns their fingerprint. Artwork is stored under `dataDir`.
 *
 * @returns The scan's counts, or `LibraryUnavailable` when a folder cannot be read, or
 *   `LibraryEmpty` when one holds no audio files although the core knows songs in it, or the
 *   catalog's error.
 */
export const scanLibrary = Effect.fn("MusicScan.library")(function* <E>(
  scan: {
    readonly libraryId: string;
    readonly folders: ReadonlyArray<string>;
    readonly dataDir: string;
  },
  catalog: ScanCatalog<E>,
  progress: Ref.Ref<ScanProgress>,
  releasedArt: Ref.Ref<HashSet.HashSet<string>>,
): Effect.fn.Return<ScanSummary, E | LibraryUnavailable | LibraryEmpty> {
  const { libraryId, dataDir } = scan;

  yield* Ref.set(progress, { done: 0, total: null, message: "Listing files" });

  const walked = yield* Effect.forEach(scan.folders, (folder) =>
    walkFolder(libraryId, folder).pipe(Effect.map((files) => ({ folder, files }))),
  );

  const helpers = new Map<string, FolderFiles>(
    walked.map(({ folder, files }) => [
      folder,
      {
        artFor: folderArtLookup(files.filter((file) => isFolderArt(basename(file.relativePath)))),
        sidecarsOf: lyricsSidecarMatcher(files),
      },
    ]),
  );

  const helpersOf = (file: FoundFile): FolderFiles => {
    const found = helpers.get(file.folder);

    if (found === undefined) throw new Error(`No walk of ${file.folder}`);

    return found;
  };

  const files: ReadonlyArray<FoundFile> = walked.flatMap(({ folder, files: inFolder }) =>
    inFolder.flatMap((file) =>
      isAudioFile(file.relativePath)
        ? [
            {
              relativePath: file.relativePath,
              size: file.size,
              mtimeMs: file.mtimeMs,
              folder,
              path: `${folder}/${file.relativePath}`,
            },
          ]
        : [],
    ),
  );

  const folderArtOf = (file: FoundFile) => helpersOf(file).artFor(dirname(file.relativePath));
  const sidecarsOf = (file: FoundFile) => helpersOf(file).sidecarsOf(file.relativePath);

  yield* Ref.set(progress, {
    done: 0,
    total: null,
    message: `Found ${files.length} files, comparing`,
  });

  const known = yield* knownTracks(
    catalog,
    files.map((file) => file.path),
  );

  for (const { folder } of walked) {
    const holdsAudio = files.some((file) => file.folder === folder);

    if (
      !holdsAudio &&
      known.values().some((file) => !file.missing && Files.isInsideFolder(file.path, folder))
    ) {
      return yield* new LibraryEmpty({ folder });
    }
  }

  const changed = files.flatMap((file): ReadonlyArray<Pending> => {
    const read = readNeeded(
      known.get(file.path),
      file,
      folderArtKey(folderArtOf(file)),
      lyricsFilesKey(sidecarsOf(file)),
    );

    return read === null ? [] : [{ read, file }];
  });

  yield* Ref.set(progress, {
    done: 0,
    total: changed.length > 0 ? changed.length : null,
    message: `Found ${files.length} files, ${changed.length} changed`,
  });

  // Keyed by the artwork file's absolute path, a string, so every song that shares a folder's
  // artwork shares one read of it.
  const folderArtHashes = yield* Cache.make({
    capacity: 100_000,
    lookup: (artPath: string) =>
      Effect.gen(function* () {
        const folder = scan.folders.find((candidate) => Files.isInsideFolder(artPath, candidate));

        if (folder === undefined) return undefined;

        const inside = yield* Files.resolveWithin(folder, artPath);

        if (Option.isNone(inside)) return undefined;

        const bytes = yield* Files.readWholeFile(inside.value);

        return Option.getOrUndefined(yield* saveArt(dataDir, bytes));
      }),
  });

  const readFile = Effect.fnUntraced(function* (file: FoundFile) {
    const tags = yield* readTrackTags(file.path);
    const art = folderArtOf(file);

    const artHash =
      tags.picture !== undefined
        ? Option.getOrUndefined(yield* saveArt(dataDir, tags.picture))
        : art === undefined
          ? undefined
          : yield* Cache.get(folderArtHashes, `${file.folder}/${art.relativePath}`);

    const lyrics = yield* readTrackLyrics(file.folder, sidecarsOf(file), tags.lyrics);
    const relativeFolder = dirname(file.relativePath);
    const fileName = basename(file.relativePath);
    const extension = extensionOf(fileName);

    const track: Draft<ScannedTrack> = {
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      title:
        tags.title ?? (extension === "" ? fileName : fileName.slice(0, -(extension.length + 1))),
      artist: tags.artist ?? tags.albumArtist ?? UNKNOWN_ARTIST,
      album: tags.album ?? (relativeFolder === "." ? UNKNOWN_ALBUM : basename(relativeFolder)),
      durationMs: tags.durationMs,
      codec: tags.codec,
      lossless: tags.lossless,
      explicit: tags.explicit,
      ...lyrics,
    };

    // The core takes an absent tag as an absent field, never as undefined.
    if (tags.albumArtist !== undefined) track.albumArtist = tags.albumArtist;

    if (tags.trackNumber !== undefined) track.trackNumber = tags.trackNumber;

    if (tags.discNumber !== undefined) track.discNumber = tags.discNumber;

    if (tags.year !== undefined) track.year = tags.year;

    if (tags.genre !== undefined) track.genre = tags.genre;

    if (tags.bitrate !== undefined) track.bitrate = tags.bitrate;

    if (tags.sampleRate !== undefined) track.sampleRate = tags.sampleRate;

    if (tags.bitDepth !== undefined) track.bitDepth = tags.bitDepth;

    if (artHash !== undefined) track.artHash = artHash;

    const artFile = folderArtKey(art);

    if (artFile !== undefined) track.folderArt = artFile;

    return { read: "file", track } satisfies Read;
  });

  const readLyrics = Effect.fnUntraced(function* (file: FoundFile) {
    const embedded = yield* readTagLyrics(file.path);
    const lyrics = yield* readTrackLyrics(file.folder, sidecarsOf(file), embedded);

    return { read: "lyrics", lyrics: { path: file.path, ...lyrics } } satisfies Read;
  });

  const readOne = ({ read, file }: Pending): Effect.Effect<Option.Option<Read>> =>
    Effect.gen(function* () {
      const found: Read = read === "file" ? yield* readFile(file) : yield* readLyrics(file);

      return Option.some(found);
    }).pipe(
      Effect.catchTags({
        TagReadError: (error) =>
          Effect.logWarning("MusicScan.file_unreadable", error).pipe(Effect.as(Option.none())),
        FileError: (error) =>
          Effect.logWarning("MusicScan.file_unreadable", error).pipe(Effect.as(Option.none())),
      }),
      Effect.annotateLogs({ libraryId }),
    );

  const seen = new Set(files.map((file) => file.path));

  const vanished = known
    .values()
    .filter((file) => !seen.has(file.path))
    .toArray();

  const movedFrom = movedFileMatcher(vanished);
  const claimed = new Set<string>();
  let moved = 0;

  const saved = <Failure>(write: Effect.Effect<ReadonlyArray<string>, Failure>) =>
    write.pipe(
      Effect.tap((hashes) =>
        Ref.update(releasedArt, (current) =>
          hashes.reduce((set, hash) => HashSet.add(set, hash), current),
        ),
      ),
      Effect.uninterruptible,
    );

  const lyricsBytes = (path: string, read: { readonly lyrics: ScannedLyrics["lyrics"] }): number =>
    Math.max(Buffer.byteLength(JSON.stringify(read.lyrics)), known.get(path)?.lyricsBytes ?? 0);

  let done = 0;
  let failed = 0;

  const save = Effect.fnUntraced(function* (read: ReadonlyArray<Option.Option<Read>>) {
    const found = read.flatMap(Option.toArray);
    const moves: Array<TrackMove> = [];
    const upserts: Array<ScannedTrack> = [];
    const lyrics: Array<ScannedLyrics> = [];

    for (const item of found) {
      if (item.read === "lyrics") {
        lyrics.push(item.lyrics);
        continue;
      }

      const { track } = item;
      const from = known.has(track.path) ? undefined : movedFrom(track);

      if (from === undefined) upserts.push(track);
      else moves.push({ from, track });
    }

    failed += read.length - found.length;

    for (const batch of byLyricsSize(upserts, (track) => lyricsBytes(track.path, track))) {
      yield* saved(catalog.upsert(batch));
    }

    for (const batch of byLyricsSize(moves, (move) => lyricsBytes(move.from, move.track))) {
      yield* saved(
        catalog.move(batch).pipe(
          Effect.map((result) => {
            moved += result.moved;

            return result.released;
          }),
        ),
      );
    }

    for (const batch of byLyricsSize(lyrics, (track) => lyricsBytes(track.path, track))) {
      yield* catalog.lyrics(batch);
    }

    for (const { from } of moves) claimed.add(from);
    done += read.length;

    yield* Ref.set(progress, {
      done,
      total: changed.length,
      message: `Read ${done} of ${changed.length} changed files`,
    });
  });

  yield* Stream.fromIterable(chunks(changed, READ_BATCH)).pipe(
    Stream.mapEffect((batch) => Effect.forEach(batch, readOne, { concurrency: TAG_CONCURRENCY })),
    Stream.buffer({ capacity: 1 }),
    Stream.runForEach(save),
  );

  const gone = vanished
    .filter((file) => !file.missing && !claimed.has(file.path))
    .map((file) => file.path);

  for (const batch of chunks(gone, MISSING_BATCH)) {
    yield* saved(catalog.missing(batch));
  }

  const summary: ScanSummary = {
    files: files.length,
    updated: changed.length - failed - moved,
    moved,
    missing: gone.length,
    failed,
  };

  yield* Ref.set(progress, {
    done: changed.length,
    total: changed.length,
    message: describeScan(summary),
  });

  return summary;
});
