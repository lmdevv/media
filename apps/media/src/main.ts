import { createHash } from "node:crypto";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { LibraryId } from "@media/contracts/ids";
import { Cause, Context, Effect, Exit, Layer, Option, Runtime, Schema } from "effect";

import * as ArtworkKeys from "./artwork/artwork-keys.ts";
import * as BackupJob from "./backups/backup-job.ts";
import * as BackupRoutes from "./backups/backup-routes.ts";
import * as Backups from "./backups/backups.ts";
import * as ConvexCli from "./backups/convex-cli.ts";
import * as BackendHealth from "./backend-health.ts";
import * as CachePruner from "./cache-pruner.ts";
import * as ConvexFileResolver from "./convex/convex-file-resolver.ts";
import * as ConvexLibrarySink from "./convex/convex-library-sink.ts";
import * as ConvexPlaybackReporter from "./convex/convex-playback-reporter.ts";
import * as ConvexSessionReports from "./convex/convex-session-reports.ts";
import * as ClientErrors from "./diagnostics/client-errors.ts";
import * as DiagnosticsRoutes from "./diagnostics/diagnostics-routes.ts";
import * as LibrarySync from "./convex/library-sync.ts";
import * as MediaBackend from "./convex/media-backend.ts";
import * as ViewerAuth from "./convex/viewer-auth.ts";
import * as HttpServer from "./http/http-server.ts";
import * as MetadataRoutes from "./http/metadata-routes.ts";
import * as Outbound from "./http/outbound.ts";
import * as JobWorker from "./jobs/job-worker.ts";
import * as MetadataJob from "./jobs/metadata-job.ts";
import * as PersonJob from "./jobs/person-job.ts";
import * as ScanJob from "./jobs/scan-job.ts";
import * as FolderRoutes from "./library/folder-routes.ts";
import * as LibraryMonitor from "./library/library-monitor.ts";
import * as LogsRoutes from "./logging/logs-routes.ts";
import * as RetainedLogs from "./logging/retained-logs.ts";
import * as MemoryLibrary from "./library/memory-library.ts";
import * as MediaConfig from "./media-config.ts";
import { servicesLayer } from "./media-service.ts";
import * as MigrationBackend from "./migration/migration-backend.ts";
import * as MigrationJob from "./migration/migration-job.ts";
import * as MigrationRoutes from "./migration/migration-routes.ts";
import * as Migrations from "./migration/migrations.ts";
import * as Observability from "./observability.ts";
import * as EndedSessions from "./playback/ended-sessions.ts";
import * as PlaybackReporter from "./playback/playback-reporter.ts";
import * as SessionReports from "./playback/session-reports.ts";
import * as TrickplayJob from "./trickplay/trickplay-job.ts";
import * as TrickplaySweep from "./trickplay/trickplay-sweep.ts";

class MediaServiceKeyMissing extends Schema.TaggedError<MediaServiceKeyMissing>()(
  "MediaServiceKeyMissing",
  {},
) {
  override get message(): string {
    return "Media service key missing: CONVEX_URL is set but MEDIA_SERVICE_API_KEY is not; run packages/backend/scripts/configure.ts";
  }
}

const jobHandlers = Effect.all([
  Effect.all([
    ScanJob.handler,
    MetadataJob.handler,
    PersonJob.handler,
    MigrationJob.handler,
    BackupJob.handler,
  ]),
  TrickplayJob.handlers,
]).pipe(Effect.map(([always, trickplay]) => [...always, ...trickplay]));

const commandRoutes = Layer.mergeAll(
  MetadataRoutes.layer,
  MigrationRoutes.layer,
  BackupRoutes.layer,
  FolderRoutes.layer,
  LogsRoutes.layer,
  DiagnosticsRoutes.layer,
  ClientErrors.layer,
);

const convexMode = (options: MediaBackend.Options) =>
  Layer.mergeAll(
    HttpServer.layer(commandRoutes),
    JobWorker.layer(jobHandlers),
    LibrarySync.layer,
    TrickplaySweep.layer,
    Backups.layerSyncOnStart,
    CachePruner.layer,
  ).pipe(
    Layer.provide(Backups.layer.pipe(Layer.provide(ConvexCli.layer))),
    Layer.provide(LibraryMonitor.layer()),
    Layer.provide(servicesLayer),
    Layer.provide(Migrations.layer.pipe(Layer.provideMerge(MigrationBackend.layer))),
    Layer.provide(
      Layer.mergeAll(
        ConvexLibrarySink.layer,
        ConvexFileResolver.layer,
        ConvexPlaybackReporter.layer,
        EndedSessions.layer.pipe(Layer.provideMerge(ConvexSessionReports.layer)),
      ),
    ),
    Layer.provide(ArtworkKeys.layer),
    Layer.provide(ViewerAuth.layer(options.convexUrl)),
    Layer.provideMerge(MediaBackend.layer(options)),
  );

const standaloneMode = (roots: ReadonlyArray<string>) =>
  Layer.mergeAll(
    HttpServer.layer(Layer.empty),
    LibraryMonitor.layerTracking(
      roots.map((root) => ({
        libraryId: LibraryId.make(
          `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
        ),
        roots: [root],
      })),
    ),
    CachePruner.layer,
  ).pipe(
    Layer.provide(LibraryMonitor.layer()),
    Layer.provide(servicesLayer),
    Layer.provide(
      Layer.mergeAll(
        MemoryLibrary.layer,
        PlaybackReporter.layerLog,
        BackendHealth.layerStandalone,
        SessionReports.layerNone,
        EndedSessions.layerNone,
      ),
    ),
  );

const application = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    if (Option.isNone(config.convexUrl)) {
      yield* Effect.logInfo("Main.standalone_mode");

      return standaloneMode(config.libraryRoots);
    }

    if (Option.isNone(config.mediaServiceApiKey)) return yield* new MediaServiceKeyMissing();

    return convexMode({
      convexUrl: config.convexUrl.value,
      apiKey: config.mediaServiceApiKey.value,
    });
  }),
).pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provide(MediaConfig.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, Outbound.layer)),
);

// The main fiber never completes, so it ends only on failure or when SIGTERM or SIGINT interrupts
// it. A clean interrupt is a requested stop: exit 0, not the default 130 that systemd and Docker
// record as a failure.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0);

  return Runtime.defaultTeardown(exit, onExit);
};

Effect.gen(function* () {
  const services = yield* Layer.build(application);
  const retained = Context.get(services, RetainedLogs.Service);

  // Runs first at shutdown: an open `media logs --follow` never ends on its own, and the HTTP
  // server waits for open responses before it closes.
  yield* Effect.addFinalizer(() => retained.close);

  return yield* Effect.never;
}).pipe(Effect.scoped, NodeRuntime.runMain({ teardown }));
