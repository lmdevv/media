import { Schema } from "effect";

import { EpisodeId, LibraryId, MediaFileId, ProfileId, TitleId, UserId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { ExternalIds, LibraryKind, LibraryRoots, MetadataOverrides, TitleKind } from "./catalog";
import { MigrationSource } from "./jobs";
import {
  ImportPhase,
  MigrationImported,
  MigrationPhase,
  PathMapping,
  PlannedLibraryAccess,
} from "./migration";

/** A [movies] account and its profiles, for mapping migration source users. */
export const MigrationTarget = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  profiles: Schema.Array(Schema.Struct({ profileId: ProfileId, name: Schema.String })),
});

/** A [movies] account and its profiles. */
export interface MigrationTarget extends Schema.Schema.Type<typeof MigrationTarget> {}

/**
 * Source credentials sealed by the media service with AES-256-GCM under a key derived from its
 * `MEDIA_SERVICE_API_KEY`. Convex stores only the key's hash, so neither Convex nor a backup can
 * open them. Base64url fields.
 */
export const SealedCredentials = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Schema.String,
  ciphertext: Schema.String,
});

/** Sealed source credentials. */
export interface SealedCredentials extends Schema.Schema.Type<typeof SealedCredentials> {}

/** A mapped source user in a stored plan. */
export const PlannedUser = Schema.Struct({
  sourceUserId: Schema.String,
  profileId: ProfileId,
  history: Schema.Literals(["full", "plays"]),
});

/** A source user as a migration plan maps them. */
export interface PlannedUser extends Schema.Schema.Type<typeof PlannedUser> {}

/** A library the import adds or reuses, with folders on this host. */
export const PlannedLibrary = Schema.Struct({
  name: Schema.String,
  kind: LibraryKind,
  roots: LibraryRoots,
  /** Who sees the library if the import adds it; plans stored before this field open it to admins. */
  access: Schema.optionalKey(PlannedLibraryAccess),
});

/** A source library as a migration plan imports it. */
export interface PlannedLibrary extends Schema.Schema.Type<typeof PlannedLibrary> {}

/** Everything a migration job needs to run again after a restart. */
export const StoredMigrationPlan = Schema.Struct({
  sourceUrl: Schema.String,
  /** The source server's own identifier; one migration per server runs at a time. */
  serverId: Schema.String,
  credentials: SealedCredentials,
  users: Schema.Array(PlannedUser).check(Schema.isMaxLength(200)),
  libraries: Schema.Array(PlannedLibrary).check(Schema.isMaxLength(50)),
  pathMappings: Schema.Array(PathMapping).check(Schema.isMaxLength(50)),
});

/** A stored migration plan. */
export interface StoredMigrationPlan extends Schema.Schema.Type<typeof StoredMigrationPlan> {}

/**
 * Where a job resumes: the phase, the unit within it (such as the user index during
 * `watchState`), and how many items of that unit are already written.
 */
export const MigrationCheckpoint = Schema.Struct({
  phase: MigrationPhase,
  unit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** A migration checkpoint. */
export interface MigrationCheckpoint extends Schema.Schema.Type<typeof MigrationCheckpoint> {}

/** Arguments to queue a migration job for an admin the media service verified. */
export const StartMigrationArgs = Schema.Struct({
  requestedBy: UserId,
  source: MigrationSource,
  serverName: Schema.String,
  plan: StoredMigrationPlan,
});

/** What starting a migration takes. */
export interface StartMigrationArgs extends Schema.Schema.Type<typeof StartMigrationArgs> {}

/** A held migration job's plan and progress. */
export const MigrationState = Schema.Struct({
  source: MigrationSource,
  serverName: Schema.String,
  plan: StoredMigrationPlan,
  checkpoint: MigrationCheckpoint,
  imported: MigrationImported,
  /** Libraries the job found or added so far. */
  libraryIds: Schema.Array(LibraryId),
});

/** A held migration job's plan and progress. */
export interface MigrationState extends Schema.Schema.Type<typeof MigrationState> {}

/** A [movies] file with what matching needs: its title's provider IDs and episode numbers. */
export const CatalogFile = Schema.Struct({
  fileId: MediaFileId,
  libraryId: LibraryId,
  path: Schema.String,
  missing: Schema.Boolean,
  titleId: TitleId,
  kind: TitleKind,
  externalIds: ExternalIds,
  episodeId: Schema.NullOr(EpisodeId),
  seasonNumber: Schema.NullOr(Schema.Int),
  episodeNumber: Schema.NullOr(Schema.Int),
});

/** A [movies] file for matching. */
export interface CatalogFile extends Schema.Schema.Type<typeof CatalogFile> {}

/** A profile's progress on one item, for spotting conflicts in a dry run. */
export const LocalProgress = Schema.Struct({
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  watched: Schema.Boolean,
  positionMs: Milliseconds,
  lastPlayedAt: EpochMillis,
});

/** A profile's progress on one item. */
export interface LocalProgress extends Schema.Schema.Type<typeof LocalProgress> {}

/**
 * One matched item's watch state for one profile. Writing it twice changes nothing: watched marks
 * stay set, play counts keep the larger value, the position applies only when the source played
 * the item more recently than [movies] did, and favorites are added once.
 */
export const WatchStateImport = Schema.Struct({
  profileId: ProfileId,
  titleId: TitleId,
  /** The episode for shows; null for movies, and for a show itself (favorites only). */
  episodeId: Schema.NullOr(EpisodeId),
  fileId: Schema.NullOr(MediaFileId),
  watched: Schema.Boolean,
  positionMs: Milliseconds,
  playCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastPlayedAt: Schema.NullOr(EpochMillis),
  favorite: Schema.Boolean,
});

/** One matched item's watch state for one profile. */
export interface WatchStateImport extends Schema.Schema.Type<typeof WatchStateImport> {}

/** What one watch state batch changed. */
export const WatchStateImported = Schema.Struct({
  watched: Schema.Int,
  inProgress: Schema.Int,
  playCounts: Schema.Int,
  favorites: Schema.Int,
  keptLocal: Schema.Int,
});

/** What one watch state import changed. */
export interface WatchStateImported extends Schema.Schema.Type<typeof WatchStateImported> {}

/**
 * Most collections, and most members in all, one `importCollections` call may carry. Replacing a
 * collection deletes its old members (at most 1000) and inserts the new ones, so these keep a
 * call's reads and writes inside one Convex mutation's limits.
 */
export const COLLECTION_BATCH_LIMIT = 10;

/** Most members, summed over its collections, one `importCollections` call may carry. */
export const COLLECTION_MEMBER_BATCH_LIMIT = 2000;

/** A source collection with its matched titles. Re-importing replaces its members. */
export const CollectionImport = Schema.Struct({
  /** Stable across runs: the source, its server ID, and the collection's ID there. */
  sourceKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  name: Schema.String,
  sortName: Schema.NullOr(Schema.String),
  titleIds: Schema.Array(TitleId).check(Schema.isMaxLength(1000)),
});

/** A source collection with its matched titles. */
export interface CollectionImport extends Schema.Schema.Type<typeof CollectionImport> {}

/** Metadata fields an admin locked or customised on the source, for one matched title. */
export const OverrideImport = Schema.Struct({
  titleId: TitleId,
  overrides: MetadataOverrides,
  /**
   * The source's provider IDs. They fill IDs the title lacks (never replacing one), and a title
   * nobody matched yet gets a metadata refresh, so it matches at once.
   */
  externalIds: Schema.optionalKey(ExternalIds),
});

/** Locked source metadata and provider IDs for one matched title. */
export interface OverrideImport extends Schema.Schema.Type<typeof OverrideImport> {}

/**
 * Where an import into the core resumes: the phase, the unit within it (the user index while
 * importing watch state, the member index of the current collection), and the cursor (the item
 * index within the user, or the collection or title index).
 */
export const ImportCheckpoint = Schema.Struct({
  phase: ImportPhase,
  unit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Where an import into the core resumes. */
export interface ImportCheckpoint extends Schema.Schema.Type<typeof ImportCheckpoint> {}

/** What an import into the core has written so far. */
export const ImportedCounts = Schema.Struct({
  watched: Schema.Int,
  inProgress: Schema.Int,
  favorites: Schema.Int,
  collections: Schema.Int,
  overrides: Schema.Int,
  /** Items where the core kept its own, more recent progress. */
  keptLocal: Schema.Int,
  unmatched: Schema.Int,
});

/** What an import into the core has written so far. */
export interface ImportedCounts extends Schema.Schema.Type<typeof ImportedCounts> {}

/**
 * Everything an import into the core needs to run again after a restart. The credentials are
 * sealed by the server under its own key, so neither the core nor a backup can open them.
 */
export const ImportPlan = Schema.Struct({
  sourceUrl: Schema.String.check(Schema.isMaxLength(2048)),
  credentials: SealedCredentials,
  users: Schema.Array(
    Schema.Struct({
      sourceUserId: Schema.String,
      userId: UserId,
      history: Schema.Literals(["full", "plays"]),
    }),
  ).check(Schema.isMaxLength(200)),
  pathMappings: Schema.Array(PathMapping).check(Schema.isMaxLength(50)),
});

/** Everything an import into the core needs to run again after a restart. */
export interface ImportPlan extends Schema.Schema.Type<typeof ImportPlan> {}

/**
 * One matched item's watch state for one core user. Writing it again changes nothing: watched
 * marks stay set, a position applies only when the source played the item more recently than the
 * core did, and a favorite joins the user's list once.
 */
export const ImportWatchItem = Schema.Struct({
  userId: UserId,
  titleId: TitleId,
  /** The episode for shows; null for movies, and for a show itself (favorites only). */
  episodeId: Schema.NullOr(EpisodeId),
  fileId: Schema.NullOr(MediaFileId),
  watched: Schema.Boolean,
  positionMs: Milliseconds,
  /** A play count above 0 counts the item as played; the core keeps no count. */
  playCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastPlayedAt: Schema.NullOr(EpochMillis),
  favorite: Schema.Boolean,
});

/** One matched item's watch state for one core user. */
export interface ImportWatchItem extends Schema.Schema.Type<typeof ImportWatchItem> {}
