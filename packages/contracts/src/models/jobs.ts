import { Schema } from "effect";

import { BackupId, JobId, LibraryId, MediaFileId, PersonId, TitleId, UserId } from "../ids";
import { Bytes, EpochMillis } from "../units";

/** What started a backup: the nightly schedule or an admin. */
export const BackupTrigger = Schema.Literals(["nightly", "manual"]);

/** What started a backup. */
export type BackupTrigger = typeof BackupTrigger.Type;

/** What a job does. */
const JobKind = Schema.Literals(["scan", "metadata", "person", "backup", "migration", "trickplay"]);

/** What a job does. */
type JobKind = typeof JobKind.Type;

/** Where a job stands. A `running` job whose lease expired returns to `pending`. */
const JobStatus = Schema.Literals(["pending", "running", "succeeded", "failed", "cancelled"]);

/** Where a job stands. */
type JobStatus = typeof JobStatus.Type;

/** A scan walks every root (`full`) or only checks known paths for changes (`quick`). */
const ScanMode = Schema.Literals(["full", "quick"]);

/** Which migration source a job reads. */
export const MigrationSource = Schema.Literals(["jellyfin", "plex"]);

/** Which migration source a job reads. */
export type MigrationSource = typeof MigrationSource.Type;

/** What the worker needs to run a job, by kind. */
const JobPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scan"),
    libraryId: LibraryId,
    mode: ScanMode,
  }),
  Schema.Struct({
    kind: Schema.Literal("metadata"),
    titleId: TitleId,
    /** A manual match chosen by an admin; null refreshes from the current match. */
    match: Schema.NullOr(
      Schema.Struct({ provider: Schema.Literal("tmdb"), providerId: Schema.String }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("person"),
    /** Fetches a person's biography, dates, and photo the first time someone opens them. */
    personId: PersonId,
  }),
  Schema.Struct({
    kind: Schema.Literal("backup"),
    trigger: BackupTrigger,
  }),
  Schema.Struct({
    kind: Schema.Literal("migration"),
    source: MigrationSource,
    serverName: Schema.String,
  }),
  /** Scrub thumbnails for one file; queued after a scan finds it new or changed. */
  Schema.Struct({ kind: Schema.Literal("trickplay"), fileId: MediaFileId }),
]);

/** What the worker needs to run a job. */
type JobPayload = typeof JobPayload.Type;

/** Progress the worker reports while it holds the lease. */
const JobProgress = Schema.Struct({
  done: Schema.Int,
  total: Schema.NullOr(Schema.Int),
  message: Schema.NullOr(Schema.String),
});

/** Job progress. */
interface JobProgress extends Schema.Schema.Type<typeof JobProgress> {}

/** A job as admins see it. */
export const Job = Schema.Struct({
  id: JobId,
  kind: JobKind,
  status: JobStatus,
  payload: JobPayload,
  progress: JobProgress,
  error: Schema.NullOr(Schema.String),
  requestedBy: Schema.NullOr(UserId),
  attempts: Schema.Int,
  createdAt: EpochMillis,
  startedAt: Schema.NullOr(EpochMillis),
  finishedAt: Schema.NullOr(EpochMillis),
});

/** A job. */
export interface Job extends Schema.Schema.Type<typeof Job> {}

/** A backup archive in the media host's backup folder. */
export const Backup = Schema.Struct({
  id: BackupId,
  fileName: Schema.String,
  sizeBytes: Bytes,
  trigger: BackupTrigger,
  createdAt: EpochMillis,
});

/** A backup archive. */
export interface Backup extends Schema.Schema.Type<typeof Backup> {}

/** A backup archive as the media service finds it in its backup folder. */
export const BackupArchive = Schema.Struct({
  fileName: Schema.String,
  sizeBytes: Bytes,
  trigger: BackupTrigger,
  takenAt: EpochMillis,
});

/** A backup archive in the backup folder. */
export interface BackupArchive extends Schema.Schema.Type<typeof BackupArchive> {}
