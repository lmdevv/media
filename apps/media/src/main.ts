import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Context, Effect, Exit, Layer, Option, Runtime, Schema } from "effect";

import * as ArtworkKeys from "./artwork/artwork-keys.ts";
import * as BackendHealth from "./backend-health.ts";
import * as CachePruner from "./cache-pruner.ts";
import * as CoreWiring from "./core/core-wiring.ts";
import * as HttpServer from "./http/http-server.ts";
import * as Outbound from "./http/outbound.ts";
import * as LibraryMonitor from "./library/library-monitor.ts";
import * as MemoryLibrary from "./library/memory-library.ts";
import * as RetainedLogs from "./logging/retained-logs.ts";
import * as MediaTools from "./media/media-tools.ts";
import * as MediaConfig from "./media-config.ts";
import { servicesLayerWith } from "./media-service.ts";
import * as Observability from "./observability.ts";
import * as EndedSessions from "./playback/ended-sessions.ts";
import * as PlaybackReporter from "./playback/playback-reporter.ts";
import * as PlaybackToken from "./playback/playback-token.ts";
import * as SessionReports from "./playback/session-reports.ts";
import * as StreamOwners from "./playback/stream-owners.ts";

/** A setting the server needs on the core is missing. */
class CoreSettingMissing extends Schema.TaggedError<CoreSettingMissing>()("CoreSettingMissing", {
  setting: Schema.Literals(["MEDIA_SERVICE_API_KEY", "MEDIA_TICKET_KEYS"]),
}) {
  override get message(): string {
    return this.setting === "MEDIA_SERVICE_API_KEY"
      ? "Core setting missing: CONVEX_URL is set but MEDIA_SERVICE_API_KEY is not; issue the server a key with core/auth/apiKeys:issueServiceKey"
      : "Core setting missing: CONVEX_URL is set but MEDIA_TICKET_KEYS is not; set it to the core deployment's MEDIA_TICKET_KEYS";
  }
}

/**
 * The server with no core: it scans the approved roots into memory and reports its health, and
 * its byte routes refuse every request, since nothing issues tickets.
 */
const standaloneMode = (roots: ReadonlyArray<string>) =>
  Layer.mergeAll(
    HttpServer.layer(Layer.empty),
    LibraryMonitor.layerTracking(LibraryMonitor.rootLibraries(roots)),
    CachePruner.layer,
  ).pipe(
    Layer.provide(LibraryMonitor.layer()),
    Layer.provide(servicesLayerWith(MediaTools.layer)),
    Layer.provide(
      Layer.mergeAll(
        PlaybackToken.layerRefusing,
        StreamOwners.layer,
        ArtworkKeys.layerEphemeral,
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

    if (Option.isNone(config.mediaServiceApiKey)) {
      return yield* new CoreSettingMissing({ setting: "MEDIA_SERVICE_API_KEY" });
    }

    if (Option.isNone(config.mediaTicketKeys)) {
      return yield* new CoreSettingMissing({ setting: "MEDIA_TICKET_KEYS" });
    }

    return CoreWiring.layer({
      coreUrl: config.convexUrl.value,
      serviceKey: config.mediaServiceApiKey.value,
      ticketKeys: config.mediaTicketKeys.value,
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
