import { Effect, Layer, type Redacted } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as BackupRoutes from "../backups/backup-routes.ts";
import * as Backups from "../backups/backups.ts";
import * as ConvexCli from "../backups/convex-cli.ts";
import * as CachePruner from "../cache-pruner.ts";
import * as ClientErrors from "../diagnostics/client-errors.ts";
import * as DiagnosticsRoutes from "../diagnostics/diagnostics-routes.ts";
import * as HttpServer from "../http/http-server.ts";
import * as MetadataRoutes from "../http/metadata-routes.ts";
import * as SignInBoundary from "../http/sign-in-boundary.ts";
import * as SignInPasses from "../http/sign-in-passes.ts";
import * as FolderRoutes from "../library/folder-routes.ts";
import * as LibrarySink from "../library/library-sink.ts";
import * as LogsRoutes from "../logging/logs-routes.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MediaConfig from "../media-config.ts";
import { servicesLayerWith } from "../media-service.ts";
import * as CoreImportJob from "../migration/core-import-job.ts";
import * as CoreImports from "../migration/core-imports.ts";
import * as ImportRoutes from "../migration/import-routes.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import * as CoreBackups from "./core-backups.ts";
import * as CoreCallers from "./core-callers.ts";
import * as CoreFiles from "./core-files.ts";
import * as CoreJobs from "./core-jobs.ts";
import * as CoreMetadata from "./core-metadata.ts";
import * as CoreRescans from "./core-rescans.ts";
import * as CoreScan from "./core-scan.ts";
import * as CoreSession from "./core-session.ts";
import * as CoreStatus from "./core-status.ts";
import * as CoreTickets from "./core-tickets.ts";
import * as CoreTrickplay from "./core-trickplay.ts";

/**
 * Where the core is (`CONVEX_URL`), the key it issued this server (`MEDIA_SERVICE_API_KEY`), and
 * the ring its tickets are signed with (`MEDIA_TICKET_KEYS`). Backups and restores run the core's
 * Convex CLI with `CONVEX_SELF_HOSTED_ADMIN_KEY` from `CONVEX_BACKEND_DIR`; without them they fail
 * as unavailable, naming the missing settings.
 */
export interface Options {
  readonly coreUrl: string;
  readonly serviceKey: Redacted.Redacted;
  readonly ticketKeys: Redacted.Redacted;
}

/**
 * The server's own routes, each checking its caller against the core, and the sign-in boundary
 * at `coreUrl`, which every client signs in through (ADR 0007).
 */
const commandRoutes = (coreUrl: string) =>
  Layer.mergeAll(
    SignInBoundary.layer({ coreUrl }),
    MetadataRoutes.layer,
    ImportRoutes.layer,
    BackupRoutes.layer,
    FolderRoutes.layer,
    LogsRoutes.layer,
    DiagnosticsRoutes.layer,
    ClientErrors.layer,
  );

const jobs = (sealKey: Redacted.Redacted) =>
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    const always = yield* Effect.all([
      CoreScan.handler,
      CoreMetadata.handler,
      CoreMetadata.personHandler,
      CoreBackups.handler,
    ]);

    const imports = yield* CoreImportJob.handlers(sealKey);

    const caps: CoreJobs.PoolCaps = {
      movies: 2,
      "movies.background": config.trickplay.concurrency,
      "movies.import": 1,
      server: 1,
    };

    return { handlers: [...always, ...imports, ...(yield* CoreTrickplay.handlers)], caps };
  });

/**
 * Scans write only through a scan job's own sink, under its lease, so the scanner the shared
 * services build is never asked to write: it refuses, rather than write without a lease.
 */
const noSharedSink: Layer.Layer<LibrarySink.Service> = Layer.succeed(
  LibrarySink.Service,
  LibrarySink.Service.of({
    previousIndex: () =>
      Effect.fail(new LibrarySink.LibrarySinkFailed({ operation: "previousIndex", cause: null })),
    upsertBatch: () =>
      Effect.fail(new LibrarySink.LibrarySinkFailed({ operation: "upsertBatch", cause: null })),
    markMissing: () =>
      Effect.fail(new LibrarySink.LibrarySinkFailed({ operation: "markMissing", cause: null })),
    reportProgress: () => Effect.void,
  }),
);

/**
 * The server on the core: signed in as its service principal, running the core's jobs, serving
 * bytes to core tickets, serving its own routes to people signed in to the core, asking the core
 * to rescan what changes on disk, reporting its status, and running the Jellyfin and Plex
 * importer's flow (`CoreImports`). The retained log (`RetainedLogs`) comes from outside, as the
 * process's logging builds it. The core keeps no playback sessions (ADR 0011), so the server only
 * logs a playback's mode reports (`PlaybackReporter.layerLog`).
 */
export const layer = (options: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;

      const grants = CoreTickets.layer({
        ticketKeys: options.ticketKeys,
        idle: config.streamIdleTimeout,
      });

      return Layer.mergeAll(
        HttpServer.layer(commandRoutes(options.coreUrl)),
        CoreJobs.layer(jobs(options.serviceKey)),
        CoreTrickplay.sweepLayer,
        CoreStatus.layer,
        CoreRescans.layer,
        Backups.layerSyncOnStart,
        CachePruner.layer,
      ).pipe(
        Layer.provideMerge(CoreImports.layer(options.serviceKey)),
        Layer.provideMerge(
          Backups.layer.pipe(Layer.provide([ConvexCli.layer, CoreBackups.catalogLayer])),
        ),
        Layer.provide(CoreCallers.layer(options.coreUrl)),
        Layer.provideMerge(servicesLayerWith(MediaTools.layer)),
        Layer.provideMerge(ArtworkKeys.layerKeyed(options.serviceKey)),
        Layer.provideMerge(grants),
        Layer.provideMerge(StreamOwners.layer),
        Layer.provide(
          Layer.mergeAll(
            CoreFiles.layer,
            PlaybackReporter.layerLog,
            CoreStatus.healthLayer,
            EndedSessions.layerNone,
            noSharedSink,
          ),
        ),
        Layer.provideMerge(
          CoreSession.layer({ convexUrl: options.coreUrl, apiKey: options.serviceKey }),
        ),
        Layer.provideMerge(SignInPasses.layer(options.ticketKeys)),
      );
    }),
  );
