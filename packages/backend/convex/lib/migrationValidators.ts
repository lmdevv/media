import { v } from "convex/values";
import type { Infer } from "convex/values";

import {
  externalIds,
  job,
  libraryKind,
  metadataOverrides,
  migrationSource,
  nullable,
  titleCard,
  titleKind,
} from "./validators";

const migrationPhase = v.union(
  v.literal("libraries"),
  v.literal("scanning"),
  v.literal("watchState"),
  v.literal("collections"),
  v.literal("overrides"),
  v.literal("done"),
);

/** Mirrors `MigrationCheckpoint`. */
export const migrationCheckpoint = v.object({
  phase: migrationPhase,
  unit: v.number(),
  cursor: v.number(),
});

/** Mirrors `MigrationImported`. */
export const migrationImported = v.object({
  librariesAdded: v.number(),
  watched: v.number(),
  inProgress: v.number(),
  playCounts: v.number(),
  favorites: v.number(),
  collections: v.number(),
  overrides: v.number(),
  keptLocal: v.number(),
  unmatched: v.number(),
});

/** A migration's counts before it has imported anything. */
export const NOTHING_IMPORTED: Infer<typeof migrationImported> = {
  librariesAdded: 0,
  watched: 0,
  inProgress: 0,
  playCounts: 0,
  favorites: 0,
  collections: 0,
  overrides: 0,
  keptLocal: 0,
  unmatched: 0,
};

const pathMapping = v.object({ from: v.string(), to: v.string() });

const sealedCredentials = v.object({
  version: v.literal(1),
  nonce: v.string(),
  ciphertext: v.string(),
});

const plannedUser = v.object({
  sourceUserId: v.string(),
  profileId: v.id("profiles"),
  history: v.union(v.literal("full"), v.literal("plays")),
});

const plannedLibraryAccess = v.union(
  v.object({ kind: v.literal("everyone") }),
  v.object({ kind: v.literal("users"), sourceUserIds: v.array(v.string()) }),
);

const plannedLibrary = v.object({
  name: v.string(),
  kind: libraryKind,
  roots: v.array(v.string()),
  access: v.optional(plannedLibraryAccess),
});

/** Mirrors `StoredMigrationPlan`. */
export const storedMigrationPlan = v.object({
  sourceUrl: v.string(),
  serverId: v.string(),
  credentials: sealedCredentials,
  users: v.array(plannedUser),
  libraries: v.array(plannedLibrary),
  pathMappings: v.array(pathMapping),
});

/** Mirrors `MigrationTarget`. */
export const migrationTarget = v.object({
  userId: v.id("users"),
  name: v.string(),
  email: nullable(v.string()),
  profiles: v.array(v.object({ profileId: v.id("profiles"), name: v.string() })),
});

/** Mirrors `MigrationState`. */
export const migrationState = v.object({
  source: migrationSource,
  serverName: v.string(),
  plan: storedMigrationPlan,
  checkpoint: migrationCheckpoint,
  imported: migrationImported,
  libraryIds: v.array(v.id("libraries")),
});

/** Mirrors `MigrationRun`. */
export const migrationRun = v.object({
  job,
  source: migrationSource,
  serverName: v.string(),
  phase: migrationPhase,
  imported: migrationImported,
});

/** Mirrors `CatalogFile`. */
export const catalogFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  missing: v.boolean(),
  titleId: v.id("titles"),
  kind: titleKind,
  externalIds,
  episodeId: nullable(v.id("episodes")),
  seasonNumber: nullable(v.number()),
  episodeNumber: nullable(v.number()),
});

/** Mirrors `LocalProgress`. */
export const localProgress = v.object({
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  watched: v.boolean(),
  positionMs: v.number(),
  lastPlayedAt: v.number(),
});

/** Mirrors `WatchStateImport`. */
export const watchStateImport = v.object({
  profileId: v.id("profiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  fileId: nullable(v.id("mediaFiles")),
  watched: v.boolean(),
  positionMs: v.number(),
  playCount: v.number(),
  lastPlayedAt: nullable(v.number()),
  favorite: v.boolean(),
});

/** Mirrors `WatchStateImported`. */
export const watchStateImported = v.object({
  watched: v.number(),
  inProgress: v.number(),
  playCounts: v.number(),
  favorites: v.number(),
  keptLocal: v.number(),
});

/** Mirrors `CollectionImport`. */
export const collectionImport = v.object({
  sourceKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  titleIds: v.array(v.id("titles")),
});

/** Mirrors `OverrideImport`. */
export const overrideImport = v.object({
  titleId: v.id("titles"),
  overrides: metadataOverrides,
  externalIds: v.optional(externalIds),
});

/** Mirrors `Collection` in `@media/contracts/models/collections`. */
export const collection = v.object({
  id: v.id("collections"),
  name: v.string(),
  overview: nullable(v.string()),
  artwork: v.object({ poster: nullable(v.string()), backdrop: nullable(v.string()) }),
  titles: v.array(titleCard),
});
