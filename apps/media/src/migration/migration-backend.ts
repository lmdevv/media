import type { JobId, LibraryId, ProfileId } from "@media/contracts/ids";
import type { JobProgress } from "@media/contracts/models/jobs";
import type { MigrationImported } from "@media/contracts/models/migration";
import type {
  CatalogFile,
  CollectionImport,
  LocalProgress,
  MigrationCheckpoint,
  MigrationState,
  MigrationTarget,
  OverrideImport,
  StartMigrationArgs,
  WatchStateImport,
} from "@media/contracts/models/migration-service";
import type { MediaLibrary } from "@media/contracts/models/scan";
import { SCAN_BATCH_LIMIT } from "@media/contracts/models/scan";
import type { CallError } from "@media/sdk/effect";
import { Context, Effect, Layer } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";

/** Identifies the worker holding a job's lease. */
export interface Lease {
  readonly jobId: JobId;
  readonly workerId: string;
}

interface LibraryRequest {
  readonly name: string;
  readonly kind: "movies" | "shows" | "mixed";
  readonly roots: ReadonlyArray<string>;
}

interface WatchStateCounts {
  readonly watched: number;
  readonly inProgress: number;
  readonly playCounts: number;
  readonly favorites: number;
  readonly keptLocal: number;
}

/** Migration's view of Convex. */
export interface Interface {
  readonly targets: Effect.Effect<ReadonlyArray<MigrationTarget>, CallError>;
  readonly libraries: Effect.Effect<ReadonlyArray<MediaLibrary>, CallError>;
  /** Every catalog file, read page by page. */
  readonly catalog: Effect.Effect<ReadonlyArray<CatalogFile>, CallError>;
  readonly localProgress: (
    profileId: ProfileId,
  ) => Effect.Effect<ReadonlyArray<LocalProgress>, CallError>;
  readonly start: (args: (typeof StartMigrationArgs)["Type"]) => Effect.Effect<JobId, CallError>;
  readonly state: (lease: Lease) => Effect.Effect<MigrationState, CallError>;
  /** Records the checkpoint; true when an admin cancelled the job. */
  readonly saveCheckpoint: (
    lease: Lease,
    checkpoint: MigrationCheckpoint,
    imported: MigrationImported,
    progress: JobProgress,
  ) => Effect.Effect<boolean, CallError>;
  readonly ensureLibrary: (
    lease: Lease,
    library: LibraryRequest,
  ) => Effect.Effect<
    { readonly libraryIds: ReadonlyArray<LibraryId>; readonly created: boolean },
    CallError
  >;
  /** How many of these libraries still have a scan queued or running. */
  readonly scansPending: (libraryIds: ReadonlyArray<LibraryId>) => Effect.Effect<number, CallError>;
  readonly importWatchState: (
    lease: Lease,
    items: ReadonlyArray<WatchStateImport>,
  ) => Effect.Effect<WatchStateCounts, CallError>;
  readonly importCollections: (
    lease: Lease,
    items: ReadonlyArray<CollectionImport>,
  ) => Effect.Effect<number, CallError>;
  readonly importOverrides: (
    lease: Lease,
    items: ReadonlyArray<OverrideImport>,
  ) => Effect.Effect<number, CallError>;
}

/** Migration's view of Convex. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/MigrationBackend",
) {}

/** Most items one import call carries. */
export const BATCH_SIZE = SCAN_BATCH_LIMIT;

const allPages = <Item>(
  page: (
    cursor: string | null,
  ) => Effect.Effect<
    { readonly items: ReadonlyArray<Item>; readonly nextCursor: string | null },
    CallError
  >,
): Effect.Effect<ReadonlyArray<Item>, CallError> => {
  const step = (
    cursor: string | null,
    found: ReadonlyArray<Item>,
  ): Effect.Effect<ReadonlyArray<Item>, CallError> =>
    page(cursor).pipe(
      Effect.flatMap((result) => {
        const all = [...found, ...result.items];

        return result.nextCursor === null ? Effect.succeed(all) : step(result.nextCursor, all);
      }),
    );

  return step(null, []);
};

/** Migration over the media service's Convex connection. */
export const layer: Layer.Layer<Service, never, MediaBackend.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { call } = yield* MediaBackend.Service;

    return Service.of({
      targets: call("migrationService.targets", {}),
      libraries: call("mediaService.libraries", {}),
      catalog: allPages((cursor) => call("migrationService.catalog", { cursor, limit: 100 })),
      localProgress: (profileId) =>
        allPages((cursor) =>
          call("migrationService.localProgress", { profileId, cursor, limit: 100 }),
        ),
      start: (args) =>
        call("migrationService.start", args).pipe(Effect.map((queued) => queued.jobId)),
      state: (lease) => call("migrationService.state", lease),
      saveCheckpoint: (lease, checkpoint, imported, progress) =>
        call("migrationService.saveCheckpoint", { ...lease, checkpoint, imported, progress }).pipe(
          Effect.map((saved) => saved.cancelled),
        ),
      ensureLibrary: (lease, library) =>
        call("migrationService.ensureLibrary", {
          ...lease,
          name: library.name,
          kind: library.kind,
          roots: library.roots,
        }),
      scansPending: (libraryIds) =>
        call("migrationService.scansPending", { libraryIds }).pipe(
          Effect.map((result) => result.pending),
        ),
      importWatchState: (lease, items) =>
        call("migrationService.importWatchState", { ...lease, items }),
      importCollections: (lease, items) =>
        call("migrationService.importCollections", { ...lease, items }).pipe(
          Effect.map((result) => result.imported),
        ),
      importOverrides: (lease, items) =>
        call("migrationService.importOverrides", { ...lease, items }).pipe(
          Effect.map((result) => result.imported),
        ),
    });
  }),
);
