import { Context, type Effect, Schema } from "effect";

import type { LibraryId } from "@media/contracts/ids";
import { MediaProbe } from "../media/media-probe.ts";
import { EpisodeMetadata, TitleMetadata } from "../metadata/title-metadata.ts";
import { MediaName } from "./media-naming.ts";
import { SidecarSubtitle } from "./sidecar-subtitles.ts";

/** One folder of a library, as a scan walks it. A library may have several. */
export interface LibraryFolder {
  readonly libraryId: LibraryId;
  /** Absolute path of the folder, as the library records it. */
  readonly root: string;
}

const IndexedFile = Schema.Struct({
  relativePath: Schema.String,
  sizeBytes: Schema.Int,
  modifiedAtMs: Schema.Finite,
  sidecarDigest: Schema.optional(Schema.String),
  /** The reader revision (`PROBE_REVISION`) its stored probe comes from; absent before one was. */
  probeRevision: Schema.optional(Schema.Int),
});

interface IndexedFile extends Schema.Schema.Type<typeof IndexedFile> {}

/** One new or changed media file with everything the scan learned about it. */
export const ScannedFile = Schema.Struct({
  relativePath: Schema.String,
  sizeBytes: Schema.Int,
  modifiedAtMs: Schema.Finite,
  /** Digest of the companions this file's metadata came from (NFO, artwork, subtitles). */
  sidecarDigest: Schema.String,
  name: MediaName,
  probe: MediaProbe,
  /** The revision of the reader that made `probe` (`PROBE_REVISION`). */
  probeRevision: Schema.Int,
  subtitles: Schema.Array(SidecarSubtitle),
  /** Movie metadata, or the show's metadata for an episode. Absent for extras. */
  title: Schema.optional(TitleMetadata),
  episode: Schema.optional(EpisodeMetadata),
});

/** One new or changed media file. */
export interface ScannedFile extends Schema.Schema.Type<typeof ScannedFile> {}

/**
 * A file found unchanged whose stored probe an older reader revision made, probed again: the size
 * and modification time it was found with, and its new probe.
 */
export const ReprobedFile = Schema.Struct({
  relativePath: Schema.String,
  sizeBytes: Schema.Int,
  modifiedAtMs: Schema.Finite,
  probe: MediaProbe,
  /** The revision of the reader that made `probe` (`PROBE_REVISION`). */
  probeRevision: Schema.Int,
});

/** A file probed again. */
export interface ReprobedFile extends Schema.Schema.Type<typeof ReprobedFile> {}

/** What the store did with probes read again: how many it stored, and the files it could not fit. */
export interface Reprobing {
  readonly written: number;
  readonly unfit: ReadonlyArray<string>;
}

/** Scan progress counters. */
export const ScanProgress = Schema.Struct({
  phase: Schema.Literals(["walking", "processing", "reconciling", "done"]),
  /** Media files found so far. */
  discovered: Schema.Int,
  /**
   * Files skipped because their size, modification time, and companions did not change since a
   * probe by this reader revision.
   */
  unchanged: Schema.Int,
  /** New or changed files probed and stored. */
  processed: Schema.Int,
  /** Unchanged files whose stored probe an older reader made, probed again and stored. */
  reprobed: Schema.Int,
  /**
   * Unchanged files probed again whose new probe was not stored, as each changed since or its
   * probe could not fit beside the rest of its row; they keep their old probe and revision.
   */
  reprobeKept: Schema.Int,
  /** Files that could not be probed. */
  failed: Schema.Int,
  /** Previously known files no longer on disk. */
  missing: Schema.Int,
});

/** Scan progress counters. */
export interface ScanProgress extends Schema.Schema.Type<typeof ScanProgress> {}

/** The store rejected or could not take a scan update. */
export class LibrarySinkFailed extends Schema.TaggedError<
  LibrarySinkFailed,
  { readonly brand: unique symbol }
>()("LibrarySinkFailed", {
  operation: Schema.Literals([
    "previousIndex",
    "upsertBatch",
    "reprobed",
    "markMissing",
    "reportProgress",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Library sink failed during ${this.operation}`;
  }
}

/** Receives scan results. Batches hold at most 100 records. */
export interface Interface {
  /** Present files the store holds under the folder, relative to it. */
  readonly previousIndex: (
    folder: LibraryFolder,
  ) => Effect.Effect<ReadonlyArray<IndexedFile>, LibrarySinkFailed>;
  readonly upsertBatch: (
    folder: LibraryFolder,
    files: ReadonlyArray<ScannedFile>,
  ) => Effect.Effect<void, LibrarySinkFailed>;
  /**
   * Stores the probes of files probed again and the revision that read them, and nothing else of
   * them: no title, episode, or companion changes, so a probe read again never moves a file. A
   * file changed since (another size or modification time) is left as stored, as is one whose
   * probe cannot fit beside the rest of its row (`unfit`, relative to the folder).
   */
  readonly reprobed: (
    folder: LibraryFolder,
    files: ReadonlyArray<ReprobedFile>,
  ) => Effect.Effect<Reprobing, LibrarySinkFailed>;
  /** Marks files missing. The store keeps their watch history until an administrator purges them. */
  readonly markMissing: (
    folder: LibraryFolder,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<void, LibrarySinkFailed>;
  readonly reportProgress: (
    folder: LibraryFolder,
    progress: ScanProgress,
  ) => Effect.Effect<void, LibrarySinkFailed>;
}

/** The library sink. */
export class Service extends Context.Service<Service, Interface>()("@media/server/LibrarySink") {}
