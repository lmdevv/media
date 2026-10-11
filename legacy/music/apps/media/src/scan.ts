/**
 * Scans one library folder into Convex: list audio files, skip the ones Convex already has with
 * the same size and modification time, read tags for the rest, upsert them in batches, and mark
 * files that disappeared as missing. Every write is keyed by library and relative path, so running
 * a scan twice is safe.
 */
import { basename, dirname, join } from "node:path";

import type { LibraryId } from "@music/commands/ids";
import { Cache, Effect, Option, Ref, Schema } from "effect";

import { saveArt } from "./art-store.ts";
import { extensionOf, isAudioFile } from "./audio-format.ts";
import * as Files from "./files.ts";
import {
  type Fingerprint,
  type FingerprintPage,
  type JobProgress,
  MediaBackend,
  type ScannedTrack,
} from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import type { WalkedFile } from "./platform/node-files.ts";
import { readTrackTags } from "./tag-reader.ts";

const UPSERT_BATCH = 100;

const MISSING_BATCH = 200;

const TAG_CONCURRENCY = 8;

const FOLDER_ART = /^(cover|folder|front)\.(jpe?g|png|webp)$/i;

const FOLDER_ART_ORDER = ["cover", "folder", "front"];

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

/** The library being scanned. */
export interface ScanTarget {
  readonly id: LibraryId;
  /** Absolute folder path. */
  readonly path: string;
}

/** Counts from a finished scan. */
export interface ScanSummary {
  readonly files: number;
  readonly updated: number;
  readonly missing: number;
  readonly failed: number;
}

/** A one-line description of a scan result for the jobs list. */
export const describeScan = (summary: ScanSummary): string => {
  const parts = [
    `${summary.files} files`,
    `${summary.updated} updated`,
    `${summary.missing} missing`,
  ];

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
): boolean =>
  known !== undefined &&
  !known.missing &&
  known.size === file.size &&
  known.mtimeMs === file.mtimeMs;

const folderArtRank = (name: string): number =>
  FOLDER_ART_ORDER.indexOf(name.slice(0, name.lastIndexOf(".")).toLowerCase());

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
 */
export const scanLibrary = Effect.fn("Scan.library")(function* (
  library: ScanTarget,
  progress: Ref.Ref<JobProgress>,
) {
  const backend = yield* MediaBackend;
  const { dataDir } = yield* MediaConfig;

  yield* Ref.set(progress, { done: 0, message: "Listing files" });

  const files = yield* Files.walkTree(library.path, isAudioFile).pipe(
    Effect.mapError(
      (cause) => new LibraryUnavailable({ libraryId: library.id, path: library.path, cause }),
    ),
  );

  yield* Ref.set(progress, { done: 0, message: `Found ${files.length} files, comparing` });
  const known = yield* knownFingerprints(library.id);
  const changed = files.filter((file) => !isUnchanged(known.get(file.relativePath), file));

  const folderArt = yield* Cache.make({
    capacity: 100_000,
    lookup: (directory: string) =>
      Effect.gen(function* () {
        const names = yield* Files.listNames(directory);

        const [best] = names
          .filter((name) => FOLDER_ART.test(name))
          .toSorted((a, b) => folderArtRank(a) - folderArtRank(b));

        if (best === undefined) return undefined;
        const inside = yield* Files.resolveWithin(library.path, join(directory, best));

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

      const artHash =
        tags.picture === undefined
          ? yield* Cache.get(folderArt, dirname(absolute))
          : Option.getOrUndefined(yield* saveArt(dataDir, tags.picture));

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

  let done = 0;
  let failed = 0;

  for (const batch of chunks(changed, UPSERT_BATCH)) {
    const read = yield* Effect.forEach(batch, readOne, { concurrency: TAG_CONCURRENCY });
    const tracks = read.flatMap((track) => (Option.isSome(track) ? [track.value] : []));

    failed += read.length - tracks.length;

    if (tracks.length > 0) yield* backend.upsertTracks(library.id, tracks);
    done += batch.length;
    yield* Ref.set(progress, {
      done,
      total: changed.length,
      message: `Read ${done} of ${changed.length} changed files`,
    });
  }

  const seen = new Set(files.map((file) => file.relativePath));

  const gone = known
    .values()
    .filter((file) => !file.missing && !seen.has(file.path))
    .map((file) => file.path)
    .toArray();

  for (const batch of chunks(gone, MISSING_BATCH)) yield* backend.markMissing(library.id, batch);

  const summary: ScanSummary = {
    files: files.length,
    updated: changed.length - failed,
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
