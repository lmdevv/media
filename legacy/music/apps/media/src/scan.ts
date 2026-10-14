/**
 * Scans one library folder into Convex: list audio files, skip the ones Convex already has with
 * the same size and modification time (and the same folder artwork beside them), read tags for
 * the rest, upsert them in batches, and mark files that disappeared as missing. A new file that
 * is a gone one moved or renamed (see `moved-files.ts`) moves that track instead, keeping its
 * likes, plays, and playlist entries. Every write is keyed by library and relative path, so
 * running a scan twice is safe.
 */
import { basename, dirname, join } from "node:path";

import type { LibraryId } from "@music/commands/ids";
import { Cache, Effect, Option, Ref, Schema } from "effect";

import { saveArt } from "./art-store.ts";
import { extensionOf, isAudioFile } from "./audio-format.ts";
import * as Files from "./files.ts";
import { folderArtKey, folderArtLookup, isFolderArt } from "./folder-art.ts";
import {
  type Fingerprint,
  type FingerprintPage,
  type JobProgress,
  MediaBackend,
  type ScannedTrack,
  type TrackMove,
} from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import { movedFileMatcher } from "./moved-files.ts";
import type { WalkedFile } from "./platform/node-files.ts";
import { readTrackTags } from "./tag-reader.ts";

const UPSERT_BATCH = 100;

const MISSING_BATCH = 200;

const TAG_CONCURRENCY = 8;

/** The message of an unreadable folder somewhere in an error's cause chain, if any. */
const unreadableReason = (cause: Error | undefined, depth = 0): string | null => {
  if (cause === undefined || depth > 4) return null;

  if (cause.name === "UnreadableFolder") return cause.message;

  return unreadableReason(cause.cause instanceof Error ? cause.cause : undefined, depth + 1);
};

/** The library folder is missing or is not a readable directory. */
export class LibraryUnavailable extends Schema.TaggedError<LibraryUnavailable>()(
  "LibraryUnavailable",
  {
    libraryId: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause : undefined;

    return unreadableReason(cause) ?? `Library folder unavailable: ${this.path}`;
  }
}

/**
 * The library folder holds no audio files while Convex knows songs in it: most likely a network
 * share or a drive that is not mounted, whose empty mount point reads fine. The scan stops
 * without marking anything missing. Losing every song to an unmounted drive is worse than
 * keeping songs that were all deleted on purpose, which deleting the library clears.
 */
export class LibraryEmpty extends Schema.TaggedError<LibraryEmpty>()("LibraryEmpty", {
  libraryId: Schema.String,
  path: Schema.String,
}) {
  override get message(): string {
    return (
      `The folder is empty. Is the drive mounted? (${this.path}) ` +
      "If its music was removed on purpose, delete the library."
    );
  }
}

/** The library being scanned. */
export interface ScanTarget {
  readonly id: LibraryId;
  /** Absolute folder path. */
  readonly path: string;
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

/** A one-line description of a scan result for the jobs list. */
export const describeScan = (summary: ScanSummary): string => {
  const parts = [`${summary.files} files`, `${summary.updated} updated`];

  if (summary.moved > 0) parts.push(`${summary.moved} moved`);
  parts.push(`${summary.missing} missing`);

  if (summary.failed > 0) parts.push(`${summary.failed} unreadable`);

  return parts.join(", ");
};

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const isUnchanged = (
  known: Fingerprint | undefined,
  file: { size: number; mtimeMs: number },
  folderArt: string | undefined,
): boolean =>
  known !== undefined &&
  !known.missing &&
  known.size === file.size &&
  known.mtimeMs === file.mtimeMs &&
  known.folderArt === folderArt;

const knownFingerprints = Effect.fn("Scan.knownFingerprints")(function* (libraryId: LibraryId) {
  const backend = yield* MediaBackend;
  const known = new Map<string, Fingerprint>();
  let cursor: string | null = null;
  let done = false;

  while (!done) {
    const page: FingerprintPage = yield* backend.fingerprints(libraryId, cursor);

    for (const file of page.files) known.set(file.path, file);
    cursor = page.cursor;
    ({ done } = page);
  }

  return known;
});

/**
 * Scans `library`, writing progress into `progress` as it goes. Unreadable files are skipped and
 * counted; they are retried on the next scan because Convex never learns their fingerprint.
 *
 * @returns The scan's counts, or `LibraryUnavailable` when the folder cannot be read, or
 *   `LibraryEmpty` when it holds no audio files although the library has songs.
 */
export const scanLibrary = Effect.fn("Scan.library")(function* (
  library: ScanTarget,
  progress: Ref.Ref<JobProgress>,
) {
  const backend = yield* MediaBackend;
  const { dataDir } = yield* MediaConfig;

  yield* Ref.set(progress, { done: 0, message: "Listing files" });

  const walked = yield* Files.walkTree(
    library.path,
    (name) => isAudioFile(name) || isFolderArt(name),
  ).pipe(
    Effect.mapError(
      (cause) => new LibraryUnavailable({ libraryId: library.id, path: library.path, cause }),
    ),
  );

  const files = walked.filter((file) => isAudioFile(file.relativePath));
  const artFor = folderArtLookup(walked.filter((file) => !isAudioFile(file.relativePath)));
  const folderArtOf = (file: WalkedFile) => artFor(dirname(file.relativePath));

  yield* Ref.set(progress, { done: 0, message: `Found ${files.length} files, comparing` });
  const known = yield* knownFingerprints(library.id);

  if (files.length === 0 && known.values().some((file) => !file.missing)) {
    return yield* new LibraryEmpty({ libraryId: library.id, path: library.path });
  }

  const changed = files.filter(
    (file) => !isUnchanged(known.get(file.relativePath), file, folderArtKey(folderArtOf(file))),
  );

  // Artwork hashes by library-relative artwork file, so each cover is read once per scan.
  const folderArt = yield* Cache.make({
    capacity: 100_000,
    lookup: (relativePath: string) =>
      Effect.gen(function* () {
        const inside = yield* Files.resolveWithin(library.path, join(library.path, relativePath));

        // A cover that links out of the library would publish an outside file as artwork.
        if (Option.isNone(inside)) return undefined;
        const bytes = yield* Files.readWholeFile(inside.value);

        return Option.getOrUndefined(yield* saveArt(dataDir, bytes));
      }),
  });

  const readOne = (file: WalkedFile): Effect.Effect<Option.Option<ScannedTrack>> =>
    Effect.gen(function* () {
      const absolute = join(library.path, file.relativePath);
      const tags = yield* readTrackTags(absolute);
      const art = folderArtOf(file);

      const artHash =
        tags.picture !== undefined
          ? Option.getOrUndefined(yield* saveArt(dataDir, tags.picture))
          : art === undefined
            ? undefined
            : yield* Cache.get(folderArt, art.relativePath);

      const folder = dirname(file.relativePath);
      const fileName = basename(file.relativePath);
      const extension = extensionOf(fileName);

      const track: ScannedTrack = {
        path: file.relativePath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        title:
          tags.title ?? (extension === "" ? fileName : fileName.slice(0, -(extension.length + 1))),
        artist: tags.artist ?? tags.albumArtist ?? "Unknown Artist",
        albumArtist: tags.albumArtist,
        album: tags.album ?? (folder === "." ? "Unknown Album" : basename(folder)),
        trackNumber: tags.trackNumber,
        discNumber: tags.discNumber,
        year: tags.year,
        genre: tags.genre,
        durationMs: tags.durationMs,
        codec: tags.codec,
        lossless: tags.lossless,
        bitrate: tags.bitrate,
        sampleRate: tags.sampleRate,
        bitDepth: tags.bitDepth,
        artHash,
        folderArt: folderArtKey(art),
      };

      return Option.some(track);
    }).pipe(
      Effect.catchTags({
        TagReadError: (error) =>
          Effect.logWarning("Scan.file_unreadable", error).pipe(Effect.as(Option.none())),
        FileError: (error) =>
          Effect.logWarning("Scan.file_unreadable", error).pipe(Effect.as(Option.none())),
      }),
      Effect.annotateLogs({ libraryId: library.id }),
    );

  const seen = new Set(files.map((file) => file.relativePath));

  const vanished = known
    .values()
    .filter((file) => !seen.has(file.path))
    .toArray();

  const movedFrom = movedFileMatcher(vanished);
  // Gone paths a found file took over: moved, or stored anew with the old one marked missing.
  const claimed = new Set<string>();
  let moved = 0;

  let done = 0;
  let failed = 0;

  for (const batch of chunks(changed, UPSERT_BATCH)) {
    const read = yield* Effect.forEach(batch, readOne, { concurrency: TAG_CONCURRENCY });
    const tracks = read.flatMap((track) => (Option.isSome(track) ? [track.value] : []));
    const moves: Array<TrackMove> = [];
    const upserts: Array<ScannedTrack> = [];

    for (const track of tracks) {
      const from = known.has(track.path) ? undefined : movedFrom(track);

      if (from === undefined) upserts.push(track);
      else moves.push({ from, track });
    }

    failed += read.length - tracks.length;

    if (upserts.length > 0) yield* backend.upsertTracks(library.id, upserts);

    if (moves.length > 0) moved += yield* backend.moveTracks(library.id, moves);

    for (const { from } of moves) claimed.add(from);
    done += batch.length;
    yield* Ref.set(progress, {
      done,
      total: changed.length,
      message: `Read ${done} of ${changed.length} changed files`,
    });
  }

  const gone = vanished
    .filter((file) => !file.missing && !claimed.has(file.path))
    .map((file) => file.path);

  for (const batch of chunks(gone, MISSING_BATCH)) yield* backend.markMissing(library.id, batch);

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
