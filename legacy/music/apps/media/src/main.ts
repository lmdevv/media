/**
 * Media service entrypoint: wires configuration, Convex, the transcoder, and the long-running
 * processes, then runs until SIGINT or SIGTERM interrupts it and every layer has shut down.
 */
import { Cause, Effect, Exit, Layer, Logger } from "effect";

import * as HttpServer from "./http-server.ts";
import * as JobWorker from "./job-worker.ts";
import * as LibraryWatcher from "./library-watcher.ts";
import * as LrclibClient from "./lrclib-client.ts";
import * as LyricsWorker from "./lyrics-worker.ts";
import * as MediaBackend from "./media-backend.ts";
import * as MediaConfig from "./media-config.ts";
import * as RootClaim from "./root-claim.ts";
import * as Transcoder from "./transcoder.ts";

const services = Layer.mergeAll(MediaBackend.layer, Transcoder.layer, LrclibClient.layer).pipe(
  Layer.provideMerge(MediaConfig.layer),
);

const processes = Layer.mergeAll(
  HttpServer.layer,
  JobWorker.layer,
  LibraryWatcher.layer,
  LyricsWorker.layer,
  RootClaim.layer,
).pipe(Layer.provide(services));

const main = Layer.launch(processes).pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Media.stopped", cause),
  ),
  Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleJson])),
);

// `NodeRuntime.runMain` is marked unstable in Effect 4.0.2, so the entrypoint owns signals itself.
const fiber = Effect.runFork(main);

const stop = (): void => {
  fiber.interruptUnsafe();
};

process.once("SIGINT", stop);

process.once("SIGTERM", stop);

fiber.addObserver((exit) => {
  process.exitCode = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0;
});
