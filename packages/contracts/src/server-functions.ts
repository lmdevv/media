/**
 * The core's server functions: the Convex functions behind the `media-service` guard that only the
 * server calls, signed in as its service principal (ADR 0010). They never reach the SDK's methods
 * or the CLI. Each declaration names the function and the schemas of what it takes and answers,
 * in the shape the SDK's platform client runs (`Platform.Client`).
 */
import { Schema } from "effect";

import type { FunctionPath } from "./command";
import {
  BackupId,
  EpisodeId,
  JobId,
  LibraryId,
  MediaFileId,
  PersonId,
  TitleId,
  UserId,
} from "./ids";
import { Artwork, ExternalIds, TitleKind } from "./models/catalog";
import { BackupArchive, BackupTrigger, MigrationSource } from "./models/jobs";
import { ImportId } from "./models/migration";
import {
  CatalogFile,
  CollectionImport,
  ImportCheckpoint,
  ImportPlan,
  ImportWatchItem,
  ImportedCounts,
  LocalProgress,
  OverrideImport,
} from "./models/migration-service";
import {
  IndexedFile,
  ResolvedFile,
  ScannedCollection,
  ScannedCredit,
  ScannedEpisode,
  ScannedItem,
  ScannedPersonDetails,
  ScannedTitle,
  UpsertedFile,
} from "./models/scan";
import { TrickplayManifest } from "./trickplay";
import { Bytes, EpochMillis } from "./units";

/** One server function: its Convex function and the schemas of its arguments and answer. */
export interface ServerFunction<
  Kind extends "query" | "mutation",
  Args extends Schema.Top,
  Result extends Schema.Top,
> {
  /** A name for logs and errors, such as `core.jobs.claim`. */
  readonly name: string;
  readonly kind: Kind;
  readonly path: FunctionPath;
  readonly args: Args;
  readonly result: Result;
}

const serverQuery = <Args extends Schema.Top, Result extends Schema.Top>(
  declaration: Omit<ServerFunction<"query", Args, Result>, "kind">,
): ServerFunction<"query", Args, Result> => ({ ...declaration, kind: "query" });

const serverMutation = <Args extends Schema.Top, Result extends Schema.Top>(
  declaration: Omit<ServerFunction<"mutation", Args, Result>, "kind">,
): ServerFunction<"mutation", Args, Result> => ({ ...declaration, kind: "mutation" });

/** A held job attempt. `attempt` is the fencing token every lease-checked call carries. */
export const Lease = Schema.Struct({ jobId: JobId, attempt: Schema.Int });

/** A held job attempt. */
export interface Lease extends Schema.Schema.Type<typeof Lease> {}

/** What a lease-checked call answers: its value while the lease holds, or why the worker stops. */
export const LeaseAnswer = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("held"), value }),
    Schema.Struct({ outcome: Schema.Literal("canceled") }),
    Schema.Struct({ outcome: Schema.Literal("lost") }),
  ]);

/** The content domains, each with its own worker pools (ADR 0014). */
export const ContentDomain = Schema.Literals(["movies", "music"]);

/** A content domain. */
export type ContentDomain = typeof ContentDomain.Type;

/** The job kinds the server claims. The core's `probe.*` kinds run only in its stack suite. */
export const CoreJobKind = Schema.Literals([
  "movies.scan",
  "music.scan",
  "movies.metadata",
  "movies.person",
  "movies.trickplay",
  "movies.import.jellyfin",
  "movies.import.plex",
  "server.backup",
]);

/** A job kind the server claims. */
export type CoreJobKind = typeof CoreJobKind.Type;

/** A claimed job's payload, tagged by its kind. */
export const CoreJobPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("movies.scan"),
    libraryId: LibraryId,
    /** A full scan reads every file again; absent means incremental. */
    mode: Schema.optionalKey(Schema.Literal("full")),
  }),
  Schema.Struct({
    kind: Schema.Literal("music.scan"),
    libraryId: LibraryId,
    mode: Schema.optionalKey(Schema.Literal("full")),
  }),
  Schema.Struct({
    kind: Schema.Literal("movies.metadata"),
    titleId: TitleId,
    match: Schema.NullOr(
      Schema.Struct({ provider: Schema.Literal("tmdb"), providerId: Schema.String }),
    ),
    revision: Schema.Finite,
    generation: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("movies.person"),
    personId: PersonId,
    revision: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("movies.trickplay"),
    fileId: MediaFileId,
    /** The contents the thumbnails are for: `size:mtime`. */
    revision: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("movies.import.jellyfin"),
    source: Schema.Literal("jellyfin"),
    serverId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("movies.import.plex"),
    source: Schema.Literal("plex"),
    serverId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("server.backup"), trigger: BackupTrigger }),
]);

/** A claimed job's payload. */
export type CoreJobPayload = typeof CoreJobPayload.Type;

/** How far a job got, in the mode its kind uses. */
export const JobWork = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("reported"),
    done: Schema.Finite,
    total: Schema.NullOr(Schema.Finite),
  }),
  Schema.Struct({
    mode: Schema.Literal("items"),
    done: Schema.Finite,
    appended: Schema.Finite,
    sealed: Schema.Boolean,
  }),
]);

const Canceled = Schema.Struct({ outcome: Schema.Literal("canceled") });

const Lost = Schema.Struct({ outcome: Schema.Literal("lost") });

const Cursor = Schema.NullOr(Schema.String);

/** The longest lease the server asks for, and the shortest. */
const LeaseMs = Schema.Int.check(Schema.isBetween({ minimum: 5_000, maximum: 600_000 }));

/** Whether a personal ticket's session holds, for the server's watch on it (ADR 0011). */
export const SessionStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("live"),
    endsAt: EpochMillis,
    /** A share link's guest holds the session; its streams rank last (ADR 0014). */
    guest: Schema.Boolean,
  }),
  Schema.Struct({ state: Schema.Literal("ended") }),
]);

/** Whether a personal ticket's session holds. */
export type SessionStatus = typeof SessionStatus.Type;

/** A folder's identity, read by the scanner before it writes (ADR 0024). */
export const FolderClaim = Schema.Struct({
  folder: Schema.String,
  /** `<dev>:<ino>` of the folder's real path and of every folder above it, the folder first. */
  chain: Schema.Array(Schema.String),
  /**
   * The folder's device (`<major>:<minor>`) and its path within that device's file system, from
   * the mount table, so a bind mount of a child still lies inside its folder; null without one.
   */
  source: Schema.NullOr(Schema.Struct({ device: Schema.String, path: Schema.String })),
});

/** A folder's identity chain. */
export interface FolderClaim extends Schema.Schema.Type<typeof FolderClaim> {}

/** The page of a title's episodes a metadata job looks up, with the title's names and ids. */
export const MetadataTargetPage = Schema.Struct({
  titleId: TitleId,
  libraryId: LibraryId,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  externalIds: ExternalIds,
  artwork: Artwork,
  episodes: Schema.Array(
    Schema.Struct({ episodeId: EpisodeId, seasonNumber: Schema.Int, episodeNumber: Schema.Int }),
  ),
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

/** A page of a metadata job's target. */
export interface MetadataTargetPage extends Schema.Schema.Type<typeof MetadataTargetPage> {}

const CreditedPerson = Schema.Struct({
  personId: PersonId,
  tmdbId: Schema.NullOr(Schema.String),
  needsDetails: Schema.Boolean,
});

/** What the server reports about itself for admins' server status. */
export const ServerReport = Schema.Struct({
  version: Schema.String,
  hardwareAcceleration: Schema.Literals(["qsv", "vaapi", "none"]),
  activeStreams: Schema.Int,
  runsAwaitingExit: Schema.Int,
  startedAt: EpochMillis,
});

/** What the server reports about itself. */
export interface ServerReport extends Schema.Schema.Type<typeof ServerReport> {}

/** A page of an import's reads, from `cursor`. */
const ImportPage = <Rows extends Schema.Struct.Fields>(rows: Rows) =>
  Schema.Struct({ ...rows, continueCursor: Schema.String, isDone: Schema.Boolean });

/** What a write of an import answers: how many items it got through, and its checkpoint now. */
const ImportWrote = LeaseAnswer(
  Schema.Struct({ done: Schema.Int, at: ImportCheckpoint, imported: ImportedCounts }),
);

/** The core's server functions by name. */
export const serverFunctions = {
  jobsWaiting: serverQuery({
    name: "core.jobs.waiting",
    path: "core/jobs/worker:waiting",
    args: Schema.Struct({ kinds: Schema.Array(CoreJobKind) }),
    result: Schema.Array(
      Schema.Struct({ kind: CoreJobKind, free: Schema.Finite, ready: Schema.Boolean }),
    ),
  }),
  jobsClaim: serverMutation({
    name: "core.jobs.claim",
    path: "core/jobs/worker:claim",
    args: Schema.Struct({
      kinds: Schema.Array(CoreJobKind),
      workerId: Schema.String,
      leaseMs: LeaseMs,
    }),
    result: Schema.Union([
      Schema.Struct({
        outcome: Schema.Literal("claimed"),
        lease: Lease,
        leaseExpiresAt: EpochMillis,
        payload: CoreJobPayload,
        work: JobWork,
      }),
      Schema.Struct({ outcome: Schema.Literal("idle") }),
    ]),
  }),
  jobsReport: serverMutation({
    name: "core.jobs.report",
    path: "core/jobs/worker:report",
    args: Schema.Struct({
      lease: Lease,
      leaseMs: LeaseMs,
      message: Schema.optionalKey(Schema.String),
      progress: Schema.optionalKey(
        Schema.Struct({ done: Schema.Finite, total: Schema.NullOr(Schema.Finite) }),
      ),
    }),
    result: Schema.Union([
      Schema.Struct({
        outcome: Schema.Literal("held"),
        leaseExpiresAt: EpochMillis,
        work: JobWork,
      }),
      Schema.Struct({ outcome: Schema.Literal("outOfOrder"), appended: Schema.Finite }),
      Canceled,
      Lost,
    ]),
  }),
  jobsFinish: serverMutation({
    name: "core.jobs.finish",
    path: "core/jobs/worker:finish",
    args: Schema.Struct({
      lease: Lease,
      end: Schema.Union([
        Schema.Struct({
          outcome: Schema.Literal("succeeded"),
          message: Schema.optionalKey(Schema.String),
        }),
        Schema.Struct({
          outcome: Schema.Literal("failed"),
          error: Schema.String,
          retry: Schema.Boolean,
        }),
      ]),
    }),
    result: Schema.Union([
      Schema.Struct({
        outcome: Schema.Literal("settled"),
        status: Schema.Literals(["succeeded", "failed", "queued"]),
      }),
      Schema.Struct({ outcome: Schema.Literal("unfinished"), work: JobWork }),
      Canceled,
      Lost,
    ]),
  }),
  scanDomains: serverQuery({
    name: "core.scans.domains",
    path: "core/scans:domains",
    args: Schema.Struct({}),
    result: Schema.Array(Schema.Struct({ kind: ContentDomain, hasLibraries: Schema.Boolean })),
  }),
  scanTarget: serverMutation({
    name: "core.scans.target",
    path: "core/scans:target",
    args: Schema.Struct({ lease: Lease, kind: ContentDomain }),
    result: LeaseAnswer(
      Schema.Struct({ libraryId: LibraryId, folders: Schema.Array(Schema.String) }),
    ),
  }),
  claimFolders: serverMutation({
    name: "core.scans.claimFolders",
    path: "core/scans:claimFolders",
    args: Schema.Struct({
      lease: Lease,
      kind: ContentDomain,
      bootId: Schema.NullOr(Schema.String),
      folders: Schema.Array(FolderClaim),
    }),
    result: LeaseAnswer(
      Schema.Union([
        Schema.Struct({ claimed: Schema.Literal(true) }),
        Schema.Struct({
          claimed: Schema.Literal(false),
          folder: Schema.String,
          /** Whether the core rescans this library on its own once the owner lets go. */
          rescans: Schema.Boolean,
        }),
      ]),
    ),
  }),
  /** Queues a rescan of each movies library whose folder holds, is, or lies inside a changed path. */
  scanChanged: serverMutation({
    name: "core.scans.changed",
    path: "core/scans:changed",
    args: Schema.Struct({ path: Schema.String }),
    result: Schema.Struct({ queued: Schema.Int }),
  }),
  /**
   * A page of the movies libraries with their folders as recorded, for the server to watch
   * each folder at the path its library names.
   */
  scanWatched: serverQuery({
    name: "core.scans.watched",
    path: "core/scans:watched",
    args: Schema.Struct({
      paginationOpts: Schema.Struct({ numItems: Schema.Int, cursor: Schema.NullOr(Schema.String) }),
    }),
    result: Schema.Struct({
      page: Schema.Array(
        Schema.Struct({ libraryId: LibraryId, folders: Schema.Array(Schema.String) }),
      ),
      continueCursor: Schema.String,
      isDone: Schema.Boolean,
    }),
  }),
  moviesKnown: serverMutation({
    name: "movies.scanner.known",
    path: "movies/scanner:known",
    args: Schema.Struct({ lease: Lease, cursor: Cursor }),
    result: LeaseAnswer(
      Schema.Struct({
        files: Schema.Array(IndexedFile),
        continueCursor: Schema.String,
        isDone: Schema.Boolean,
      }),
    ),
  }),
  moviesUpsert: serverMutation({
    name: "movies.scanner.upsert",
    path: "movies/scanner:upsert",
    args: Schema.Struct({ lease: Lease, items: Schema.Array(ScannedItem) }),
    result: LeaseAnswer(Schema.Struct({ files: Schema.Array(UpsertedFile), done: Schema.Int })),
  }),
  moviesMissing: serverMutation({
    name: "movies.scanner.missing",
    path: "movies/scanner:missing",
    args: Schema.Struct({ lease: Lease, paths: Schema.Array(Schema.String) }),
    result: LeaseAnswer(Schema.Struct({ marked: Schema.Int, done: Schema.Int })),
  }),
  metadataTarget: serverQuery({
    name: "movies.metadata.target",
    path: "movies/metadata:metadataTarget",
    args: Schema.Struct({ titleId: TitleId, cursor: Cursor }),
    result: MetadataTargetPage,
  }),
  applyMetadata: serverMutation({
    name: "movies.metadata.apply",
    path: "movies/metadata:applyMetadata",
    args: Schema.Struct({
      lease: Lease,
      titleId: TitleId,
      title: ScannedTitle,
      episodes: Schema.Array(ScannedEpisode),
    }),
    result: LeaseAnswer(Schema.Struct({ done: Schema.Int, applied: Schema.Boolean })),
  }),
  applyCredits: serverMutation({
    name: "movies.metadata.applyCredits",
    path: "movies/metadata:applyCredits",
    args: Schema.Struct({
      lease: Lease,
      titleId: TitleId,
      episodeId: Schema.NullOr(EpisodeId),
      credits: Schema.Array(ScannedCredit),
      hash: Schema.String,
    }),
    result: LeaseAnswer(
      Schema.Struct({ written: Schema.Boolean, people: Schema.Array(CreditedPerson) }),
    ),
  }),
  applyCollection: serverMutation({
    name: "movies.metadata.applyCollection",
    path: "movies/metadata:applyCollection",
    args: Schema.Struct({
      lease: Lease,
      titleId: TitleId,
      collection: Schema.NullOr(ScannedCollection),
      hash: Schema.String,
    }),
    result: LeaseAnswer(Schema.Null),
  }),
  personTarget: serverQuery({
    name: "movies.people.target",
    path: "movies/people:personTarget",
    args: Schema.Struct({ personId: PersonId }),
    result: Schema.Struct({ personId: PersonId, name: Schema.String, externalIds: ExternalIds }),
  }),
  applyPerson: serverMutation({
    name: "movies.people.apply",
    path: "movies/people:applyPerson",
    args: Schema.Struct({ lease: Lease, personId: PersonId, details: ScannedPersonDetails }),
    result: LeaseAnswer(Schema.Null),
  }),
  recordTrickplay: serverMutation({
    name: "movies.trickplay.record",
    path: "movies/trickplay:recordTrickplay",
    args: Schema.Struct({
      lease: Lease,
      fileId: MediaFileId,
      sizeBytes: Bytes,
      mtimeMs: EpochMillis,
      manifest: TrickplayManifest,
    }),
    result: LeaseAnswer(Schema.Null),
  }),
  trickplayVersions: serverQuery({
    name: "movies.trickplay.versions",
    path: "movies/trickplay:trickplayVersions",
    args: Schema.Struct({ fileIds: Schema.Array(Schema.String) }),
    result: Schema.Array(
      Schema.Struct({ fileId: Schema.String, version: Schema.NullOr(Schema.String) }),
    ),
  }),
  resolveFile: serverQuery({
    name: "movies.files.resolve",
    path: "movies/files:resolveFile",
    args: Schema.Struct({ fileId: Schema.String }),
    result: Schema.NullOr(ResolvedFile),
  }),
  sessionStatus: serverQuery({
    name: "core.tickets.sessionStatus",
    path: "core/tickets:sessionStatus",
    args: Schema.Struct({ userId: Schema.String, sessionId: Schema.String }),
    result: SessionStatus,
  }),
  recordBackup: serverMutation({
    name: "core.backups.record",
    path: "core/backups:record",
    args: Schema.Struct({
      lease: Lease,
      fileName: Schema.String,
      sizeBytes: Bytes,
      takenAt: EpochMillis,
    }),
    result: LeaseAnswer(Schema.Struct({ backupId: BackupId })),
  }),
  syncBackups: serverMutation({
    name: "core.backups.sync",
    path: "core/backups:sync",
    args: Schema.Struct({
      archives: Schema.Array(BackupArchive),
      cursor: Cursor,
      /** When the server began listing its folder; rows made later stay. */
      listedAt: EpochMillis,
    }),
    result: Schema.Struct({ continueCursor: Schema.String, isDone: Schema.Boolean }),
  }),
  backupFile: serverQuery({
    name: "core.backups.file",
    path: "core/backups:file",
    args: Schema.Struct({ backupId: Schema.String }),
    result: Schema.NullOr(Schema.Struct({ fileName: Schema.String })),
  }),
  reportStatus: serverMutation({
    name: "core.serverStatus.report",
    path: "core/serverStatus:report",
    args: ServerReport,
    result: Schema.Null,
  }),
  importAllowed: serverQuery({
    name: "movies.imports.mayImport",
    path: "movies/imports:mayImport",
    args: Schema.Struct({ userId: UserId }),
    result: Schema.Boolean,
  }),
  importTargets: serverQuery({
    name: "movies.imports.targets",
    path: "movies/imports:targets",
    args: Schema.Struct({ cursor: Cursor }),
    result: ImportPage({
      users: Schema.Array(Schema.Struct({ userId: UserId, username: Schema.String })),
    }),
  }),
  importLibraries: serverQuery({
    name: "movies.imports.libraries",
    path: "movies/imports:libraries",
    args: Schema.Struct({ cursor: Cursor }),
    result: ImportPage({
      libraries: Schema.Array(
        Schema.Struct({ libraryId: LibraryId, folders: Schema.Array(Schema.String) }),
      ),
    }),
  }),
  importCatalog: serverQuery({
    name: "movies.imports.catalog",
    path: "movies/imports:catalog",
    args: Schema.Struct({ cursor: Cursor }),
    result: ImportPage({ files: Schema.Array(CatalogFile) }),
  }),
  importProgress: serverQuery({
    name: "movies.imports.progress",
    path: "movies/imports:progress",
    args: Schema.Struct({ userId: UserId, cursor: Cursor }),
    result: ImportPage({ rows: Schema.Array(LocalProgress) }),
  }),
  importStart: serverMutation({
    name: "movies.imports.start",
    path: "movies/imports:start",
    args: Schema.Struct({
      requestedBy: UserId,
      source: MigrationSource,
      serverId: Schema.String,
      serverName: Schema.String,
      plan: ImportPlan,
    }),
    result: Schema.Struct({ importId: ImportId, jobId: JobId, created: Schema.Boolean }),
  }),
  importState: serverMutation({
    name: "movies.imports.state",
    path: "movies/imports:state",
    args: Schema.Struct({ lease: Lease }),
    result: LeaseAnswer(
      Schema.Struct({
        source: MigrationSource,
        serverId: Schema.String,
        serverName: Schema.String,
        plan: ImportPlan,
        checkpoint: ImportCheckpoint,
        imported: ImportedCounts,
      }),
    ),
  }),
  importAdvance: serverMutation({
    name: "movies.imports.advance",
    path: "movies/imports:advance",
    args: Schema.Struct({
      lease: Lease,
      at: ImportCheckpoint,
      to: ImportCheckpoint,
      unmatched: Schema.Int,
    }),
    result: LeaseAnswer(Schema.Struct({ at: ImportCheckpoint, imported: ImportedCounts })),
  }),
  importEnsureLibrary: serverMutation({
    name: "movies.imports.ensureLibrary",
    path: "movies/imports:ensureLibrary",
    args: Schema.Struct({ lease: Lease, at: ImportCheckpoint }),
    result: LeaseAnswer(Schema.Struct({ at: ImportCheckpoint, imported: ImportedCounts })),
  }),
  importScansPending: serverMutation({
    name: "movies.imports.scansPending",
    path: "movies/imports:scansPending",
    args: Schema.Struct({ lease: Lease }),
    result: LeaseAnswer(Schema.Struct({ pending: Schema.Int })),
  }),
  importWatchState: serverMutation({
    name: "movies.imports.writeWatchState",
    path: "movies/imports:writeWatchState",
    args: Schema.Struct({
      lease: Lease,
      at: ImportCheckpoint,
      continueAt: Schema.optionalKey(ImportCheckpoint),
      unmatched: Schema.Int,
      items: Schema.Array(ImportWatchItem),
    }),
    result: ImportWrote,
  }),
  importCollections: serverMutation({
    name: "movies.imports.writeCollections",
    path: "movies/imports:writeCollections",
    args: Schema.Struct({
      lease: Lease,
      at: ImportCheckpoint,
      continueAt: Schema.optionalKey(ImportCheckpoint),
      items: Schema.Array(CollectionImport),
    }),
    result: ImportWrote,
  }),
  importEdits: serverMutation({
    name: "movies.imports.writeEdits",
    path: "movies/imports:writeEdits",
    args: Schema.Struct({
      lease: Lease,
      at: ImportCheckpoint,
      continueAt: Schema.optionalKey(ImportCheckpoint),
      items: Schema.Array(OverrideImport),
    }),
    result: ImportWrote,
  }),
} as const;

/** The most watch items, or title edits, one import write takes. */
export const IMPORT_ITEMS_MAX = 500;

/** The most collections one import write takes. */
export const IMPORT_COLLECTIONS_MAX = 10;

/** What one import's plan holds at most; the core refuses to start a larger one. */
export const IMPORT_PLAN_MAX = {
  users: 200,
  pathMappings: 50,
  libraries: 50,
  libraryRoots: 50,
} as const;

/** The most members of one collection an import writes. */
export const IMPORT_MEMBERS_MAX = 1000;

/** The most items one `movies/scanner:upsert` or `missing` call takes (ADR 0024). */
export const SCANNER_BATCH_MAX = 500;

/** The most episodes one `applyMetadata` call takes. */
export const METADATA_EPISODES_MAX = 500;

/** The most file ids one `trickplayVersions` call asks about. */
export const TRICKPLAY_VERSIONS_MAX = 500;

/** The most archives one `core/backups:sync` call takes. */
export const BACKUP_SYNC_MAX = 500;
