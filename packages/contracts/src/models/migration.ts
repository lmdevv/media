import { Schema } from "effect";

import { CONVEX_TABLE_ANNOTATION, JobId, LibraryId, ProfileId, UserId } from "../ids";
import { EpochMillis } from "../units";
import { LibraryKind, LibraryRoot } from "./catalog";
import { Job, MigrationSource } from "./jobs";

const SourcePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

const Secret = Schema.RedactedFromValue(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
);

/** Rewrites source folders under `from` to local folders under `to`, such as `/data` to `/mnt/nas`. */
export const PathMapping = Schema.Struct({ from: SourcePath, to: LibraryRoot });

/** A source-to-local folder prefix mapping. */
export interface PathMapping extends Schema.Schema.Type<typeof PathMapping> {}

/**
 * How to sign in to the source. `token` is a Jellyfin API key or a Plex token (`X-Plex-Token`);
 * `password` signs in to Jellyfin as an administrator. Plex accepts tokens only.
 */
export const MigrationCredentials = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("token"), token: Secret }),
  Schema.Struct({
    kind: Schema.Literal("password"),
    username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    password: Secret,
  }),
]);

/** How to sign in to the source. */
export type MigrationCredentials = typeof MigrationCredentials.Type;

/** Arguments to connect to a source server. Credentials stay in the media service. */
export const MigrationConnectArgs = Schema.Struct({
  source: MigrationSource,
  /** The server's base URL, such as `http://nas.local:8096` or `http://nas.local:32400`. */
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u), Schema.isMaxLength(2048)),
  credentials: MigrationCredentials,
  /** Folder mappings for libraries whose source paths differ from this host's mounts. */
  pathMappings: Schema.optionalKey(Schema.Array(PathMapping).check(Schema.isMaxLength(50))),
});

/** Arguments to connect to a source server. */
export interface MigrationConnectArgs extends Schema.Schema.Type<typeof MigrationConnectArgs> {}

/** Why the source server could not be used. */
export const SourceFailureReason = Schema.Literals([
  /** No answer at the URL: wrong address, server down, or a firewall. */
  "unreachable",
  /** The server refused the token or the user name and password. */
  "auth_failed",
  /** The credentials work but lack administrator rights, which reading every user needs. */
  "not_admin",
  /** The server is older than the oldest supported version. */
  "version_unsupported",
  /** The URL answered, but not like a Jellyfin or Plex server. */
  "unexpected_response",
]);

/** Why the source server could not be used. */
export type SourceFailureReason = typeof SourceFailureReason.Type;

/** The source server could not be used; the Connect screen shows "Couldn't connect". */
export const MigrationSourceFailure = Schema.Struct({
  status: Schema.Literal("failed"),
  reason: SourceFailureReason,
  message: Schema.String,
});

/** The source server could not be used. */
export interface MigrationSourceFailure extends Schema.Schema.Type<typeof MigrationSourceFailure> {}

/** The [movies] profile a source user's history goes to by default. */
export const UserSuggestion = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("profile"),
    userId: UserId,
    profileId: ProfileId,
    /** How the account was found: the same email, or the same name. */
    matchedBy: Schema.Literals(["email", "name"]),
  }),
  /** No account matches; invite this person, then map them. Import never creates accounts. */
  Schema.Struct({ kind: Schema.Literal("invite") }),
]);

/** A source user who can be mapped to a [movies] profile. */
export const SourceUser = Schema.Struct({
  sourceUserId: Schema.String,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  isAdmin: Schema.Boolean,
  suggestion: UserSuggestion,
  /**
   * `full`: watched marks, positions, play counts, and favorites. `plays`: watched marks, play
   * counts, and last-played dates only, from the server's play history (Plex users other than the
   * server owner).
   */
  history: Schema.Literals(["full", "plays"]),
});

/** A source user. */
export interface SourceUser extends Schema.Schema.Type<typeof SourceUser> {}

/** One source library folder and where it is on this host, when known. */
export const SourceFolder = Schema.Struct({
  sourcePath: SourcePath,
  /** The folder on this host after path mapping; null when no mapping or approved root covers it. */
  localPath: Schema.NullOr(LibraryRoot),
});

/** A folder of a source server library. */
export interface SourceFolder extends Schema.Schema.Type<typeof SourceFolder> {}

/**
 * Who sees a library the import adds: `everyone`, when every source user could see the source
 * library; otherwise only admins and the accounts of the listed imported source users, which get
 * a library grant. A source that does not say who sees a library yields an empty list, so the
 * library starts admins-only.
 */
export const PlannedLibraryAccess = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("everyone") }),
  Schema.Struct({
    kind: Schema.Literal("users"),
    sourceUserIds: Schema.Array(Schema.String).check(Schema.isMaxLength(200)),
  }),
]);

/** Who sees a library the import adds. */
export type PlannedLibraryAccess = typeof PlannedLibraryAccess.Type;

/** A source library and its folders. */
export const SourceLibrary = Schema.Struct({
  sourceLibraryId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["movies", "shows", "mixed", "other"]),
  folders: Schema.Array(SourceFolder),
});

/** A source library. */
export interface SourceLibrary extends Schema.Schema.Type<typeof SourceLibrary> {}

/** A mapping in effect for a connection: supplied at connect, or inferred from this host's folders. */
export const AppliedPathMapping = Schema.Struct({
  ...PathMapping.fields,
  inferred: Schema.Boolean,
});

/** A path mapping a migration applied. */
export interface AppliedPathMapping extends Schema.Schema.Type<typeof AppliedPathMapping> {}

/** A connected source server. The connection lives in the media service for an hour. */
export const MigrationConnection = Schema.Struct({
  status: Schema.Literal("connected"),
  connectionId: Schema.String,
  source: MigrationSource,
  serverName: Schema.String,
  version: Schema.String,
  users: Schema.Array(SourceUser),
  libraries: Schema.Array(SourceLibrary),
  pathMappings: Schema.Array(AppliedPathMapping),
  expiresAt: EpochMillis,
});

/** A connected source server. */
export interface MigrationConnection extends Schema.Schema.Type<typeof MigrationConnection> {}

/** The result of connecting. */
export const MigrationConnectResult = Schema.Union([MigrationConnection, MigrationSourceFailure]);

/** Which [movies] profile receives a source user's history; null skips the user. */
export const UserMapping = Schema.Struct({
  sourceUserId: Schema.String,
  profileId: Schema.NullOr(ProfileId),
});

/** A user mapping. */
export interface UserMapping extends Schema.Schema.Type<typeof UserMapping> {}

/** Arguments for a dry run or an import. */
export const MigrationPlanArgs = Schema.Struct({
  connectionId: Schema.String,
  /** Overrides of the suggested mappings. Users not listed follow their suggestion. */
  users: Schema.optionalKey(Schema.Array(UserMapping).check(Schema.isMaxLength(200))),
});

/** Arguments for a dry run or an import. */
export interface MigrationPlanArgs extends Schema.Schema.Type<typeof MigrationPlanArgs> {}

/** Why a source item will not be imported. */
export const UnmatchedReason = Schema.Literals([
  /** The item's folder is not under any mapped folder or approved library root. */
  "path_unmapped",
  /** The folder is known, but no [movies] file has this path and no provider ID matched. */
  "not_in_catalog",
  /** The source reports no file path and no provider ID matched. */
  "no_path",
]);

/** Why a source item will not be imported. */
export type UnmatchedReason = typeof UnmatchedReason.Type;

/** What a dry run found, as counts. */
export const MigrationSummary = Schema.Struct({
  usersMapped: Schema.Int,
  usersUnmapped: Schema.Int,
  librariesToAdd: Schema.Int,
  librariesExisting: Schema.Int,
  /** Movies and episodes matched to a [movies] file by path, after path mapping. */
  itemsByPath: Schema.Int,
  /** Matched by TMDB, IMDb, or TVDB ID (episodes by their show and episode number). */
  itemsByProviderId: Schema.Int,
  /** In folders import adds; they match by path once the new library's first scan finishes. */
  itemsAwaitingScan: Schema.Int,
  itemsUnmatched: Schema.Int,
  watched: Schema.Int,
  inProgress: Schema.Int,
  /** Items whose play count or last-played date will be imported. */
  playCounts: Schema.Int,
  favorites: Schema.Int,
  collections: Schema.Int,
  overrides: Schema.Int,
  /** Items whose [movies] progress was played more recently than the source's; [movies] keeps its own. */
  conflicts: Schema.Int,
});

/** Dry-run counts. */
export interface MigrationSummary extends Schema.Schema.Type<typeof MigrationSummary> {}

/** The dry-run summary the Review screen shows before anything is written. */
export const MigrationReport = Schema.Struct({
  status: Schema.Literal("ready"),
  connectionId: Schema.String,
  source: MigrationSource,
  serverName: Schema.String,
  createdAt: EpochMillis,
  summary: MigrationSummary,
  users: Schema.Array(
    Schema.Struct({
      sourceUserId: Schema.String,
      name: Schema.String,
      profileId: Schema.NullOr(ProfileId),
      /** `invite`: no account matched and none was chosen; the user is skipped this time. */
      action: Schema.Literals(["import", "skip", "invite"]),
    }),
  ),
  libraries: Schema.Array(
    Schema.Struct({
      sourceLibraryId: Schema.String,
      name: Schema.String,
      kind: LibraryKind,
      /** The folders on this host. */
      roots: Schema.Array(LibraryRoot),
      /** The [movies] library already covering these folders, or null when import adds one. */
      existingLibraryId: Schema.NullOr(LibraryId),
      /** Source folders without a local folder; their items stay unmatched. */
      unmappedFolders: Schema.Array(SourcePath),
      /** Who sees the library when the import adds it. */
      access: PlannedLibraryAccess,
    }),
  ),
  /** At most 25 unmatched items, for the Review screen. */
  unmatchedSamples: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.NullOr(Schema.String),
      reason: UnmatchedReason,
    }),
  ),
});

/** The dry-run summary. */
export interface MigrationReport extends Schema.Schema.Type<typeof MigrationReport> {}

/** The result of a dry run. */
export const MigrationDryRunResult = Schema.Union([MigrationReport, MigrationSourceFailure]);

/** The result of starting an import: the queued job, or why the source could not be read. */
export const MigrationImportResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("queued"), jobId: JobId }),
  MigrationSourceFailure,
]);

/** Where a migration job stands. Each phase resumes from its checkpoint after a restart. */
export const MigrationPhase = Schema.Literals([
  "libraries",
  "scanning",
  "watchState",
  "collections",
  "overrides",
  "done",
]);

/** A migration phase. */
export type MigrationPhase = typeof MigrationPhase.Type;

/** What a migration job has written so far. */
export const MigrationImported = Schema.Struct({
  librariesAdded: Schema.Int,
  watched: Schema.Int,
  inProgress: Schema.Int,
  playCounts: Schema.Int,
  favorites: Schema.Int,
  collections: Schema.Int,
  overrides: Schema.Int,
  /** Items where [movies] kept its own, more recent progress. */
  keptLocal: Schema.Int,
  unmatched: Schema.Int,
});

/** What a migration job has written so far. */
export interface MigrationImported extends Schema.Schema.Type<typeof MigrationImported> {}

/** A migration job with its phase and counts, for the Importing and Done screens. */
export const MigrationRun = Schema.Struct({
  job: Job,
  source: MigrationSource,
  serverName: Schema.String,
  phase: MigrationPhase,
  imported: MigrationImported,
});

/** A migration job with its phase and counts. */
export interface MigrationRun extends Schema.Schema.Type<typeof MigrationRun> {}

/**
 * An import on the core: one run of the Jellyfin or Plex importer, named by its `imports` row
 * (ADR 0012).
 */
export const ImportId = Schema.NonEmptyString.pipe(Schema.brand("ImportId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "imports",
});

/** An import ID. */
export type ImportId = typeof ImportId.Type;

/**
 * The core user a source user's history goes to by default, matched by name: the core keeps no
 * email (D13). Import never creates users.
 */
export const ImportUserSuggestion = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    userId: UserId,
    matchedBy: Schema.Literal("name"),
  }),
  /** No user matches; invite this person, then map them. */
  Schema.Struct({ kind: Schema.Literal("invite") }),
]);

/** A source user who can be mapped to a core user. */
export const ImportSourceUser = Schema.Struct({
  ...SourceUser.fields,
  suggestion: ImportUserSuggestion,
});

/** A source user who can be mapped to a core user. */
export interface ImportSourceUser extends Schema.Schema.Type<typeof ImportSourceUser> {}

/** A source server connected for an import into the core. */
export const ImportConnection = Schema.Struct({
  ...MigrationConnection.fields,
  users: Schema.Array(ImportSourceUser),
});

/** A source server connected for an import into the core. */
export interface ImportConnection extends Schema.Schema.Type<typeof ImportConnection> {}

/** Which core user receives a source user's history; null skips the source user entirely. */
export const ImportUserMapping = Schema.Struct({
  sourceUserId: Schema.String,
  userId: Schema.NullOr(UserId),
});

/** A source user's core user. */
export interface ImportUserMapping extends Schema.Schema.Type<typeof ImportUserMapping> {}

/** Arguments for a dry run or an import into the core. */
export const ImportPlanArgs = Schema.Struct({
  connectionId: Schema.String,
  /** Overrides of the suggested users. Source users not listed follow their suggestion. */
  users: Schema.optionalKey(Schema.Array(ImportUserMapping).check(Schema.isMaxLength(200))),
});

/** Arguments for a dry run or an import into the core. */
export interface ImportPlanArgs extends Schema.Schema.Type<typeof ImportPlanArgs> {}

/**
 * The dry-run summary of an import into the core, shown before anything is written: the summary
 * old movies showed, with each source user's core user. `playCounts` counts items whose last-played
 * date imports; the core keeps no play count.
 */
export const ImportReport = Schema.Struct({
  ...MigrationReport.fields,
  users: Schema.Array(
    Schema.Struct({
      sourceUserId: Schema.String,
      name: Schema.String,
      userId: Schema.NullOr(UserId),
      /** `invite`: no user matched and none was chosen; the source user is skipped this time. */
      action: Schema.Literals(["import", "skip", "invite"]),
    }),
  ),
});

/** The dry-run summary of an import into the core. */
export interface ImportReport extends Schema.Schema.Type<typeof ImportReport> {}

/** The result of a dry run into the core. */
export const ImportDryRunResult = Schema.Union([ImportReport, MigrationSourceFailure]);

/**
 * A started import into the core: its run, or the one of the same server already queued or
 * running (`created` false).
 */
export const ImportStarted = Schema.Struct({
  status: Schema.Literal("queued"),
  importId: ImportId,
  jobId: JobId,
  created: Schema.Boolean,
});

/** A started import into the core. */
export interface ImportStarted extends Schema.Schema.Type<typeof ImportStarted> {}

/** The result of starting an import into the core: its run, or why the source could not be read. */
export const ImportStartResult = Schema.Union([ImportStarted, MigrationSourceFailure]);

/** The result of connecting to a source for an import into the core. */
export const ImportConnectResult = Schema.Union([ImportConnection, MigrationSourceFailure]);

/** Where an import into the core stands; each phase resumes from its checkpoint after a restart. */
export const ImportPhase = Schema.Literals([
  "libraries",
  "scanning",
  "watchState",
  "collections",
  "overrides",
  "done",
]);

/** A phase of an import into the core. */
export type ImportPhase = typeof ImportPhase.Type;
