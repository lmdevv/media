import { Effect, Layer, Option, type Redacted } from "effect";

import * as Backups from "../backups/backups.ts";
import * as ConvexCli from "../backups/convex-cli.ts";
import * as CachePruner from "../cache-pruner.ts";
import * as HttpServer from "../http/http-server.ts";
import * as LibrarySink from "../library/library-sink.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MediaConfig from "../media-config.ts";
import { servicesLayerWith } from "../media-service.ts";
import * as CoreImportJob from "../migration/core-import-job.ts";
import * as CoreImports from "../migration/core-imports.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import * as CoreBackups from "./core-backups.ts";
import * as CoreFiles from "./core-files.ts";
import * as CoreJobs from "./core-jobs.ts";
import * as CoreMetadata from "./core-metadata.ts";
import * as CoreScan from "./core-scan.ts";
import * as CoreSession from "./core-session.ts";
import * as CoreStatus from "./core-status.ts";
import * as CoreTickets from "./core-tickets.ts";
import * as CoreTrickplay from "./core-trickplay.ts";

/** Where the core is, the key it issued this server, and the ring its tickets are signed with. */
export interface Options {
  readonly coreUrl: string;
  readonly serviceKey: Redacted.Redacted;
  readonly ticketKeys: Redacted.Redacted;
  /**
   * The core deployment's admin key and the folder its Convex CLI runs from, for backups: they
   * export the core, never old movies. Without them a backup fails as unavailable, naming them.
   */
  readonly backups: Option.Option<{
    readonly adminKey: Redacted.Redacted;
    readonly backendDir: string;
  }>;
}

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
 * bytes to core tickets, reporting its status, and running the Jellyfin and Plex importer's flow
 * (`CoreImports`). `main.ts` keeps wiring old movies until the cutover switches to this, so the
 * running server never holds two Convex URLs (D50); until then it runs in tests and the in-process
 * server.
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
        HttpServer.layer(Layer.empty),
        CoreJobs.layer(jobs(options.serviceKey)),
        CoreImports.layer(options.serviceKey),
        CoreTrickplay.sweepLayer,
        CoreStatus.layer,
        Backups.layerSyncOnStart,
        CachePruner.layer,
      ).pipe(
        Layer.provide(
          Backups.layer.pipe(
            Layer.provide([
              ConvexCli.layerFor({
                url: Option.some(options.coreUrl),
                adminKey: Option.map(options.backups, (backups) => backups.adminKey),
                backendDir: Option.map(options.backups, (backups) => backups.backendDir),
                names: {
                  url: "the core's URL",
                  adminKey: "the core's admin key",
                  backendDir: "the core's Convex folder",
                },
              }),
              CoreBackups.catalogLayer,
            ]),
          ),
        ),
        Layer.provideMerge(servicesLayerWith(MediaTools.layer)),
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
      );
    }),
  );
