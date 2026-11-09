import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Logger, Option, Path, References } from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";

import * as BackendHealth from "../backend-health.ts";
import * as ConvexSessionReports from "../convex/convex-session-reports.ts";
import { routesLayer, serve } from "../http/http-server.ts";
import type { LogRecord } from "@media/contracts/diagnostics";
import { type MediaFileId, LibraryId } from "@media/contracts/ids";
import * as LibraryScanner from "../library/library-scanner.ts";
import { decodeRecord } from "../logging/log-query.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaConfig from "../media-config.ts";
import { servicesLayer } from "../media-service.ts";
import { redactedLine } from "../observability.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as SessionReports from "../playback/session-reports.ts";
import * as FixtureWorkspace from "./fixture-workspace.ts";
import * as TestConvex from "./test-convex.ts";
import { testConfigLayer } from "./test-config.ts";

/** Where the test server listens and how to find fixture files in its store. */
export interface Interface {
  /** Every log entry so far, oldest first, redacted as the service redacts its log. */
  readonly logged: () => ReadonlyArray<LogRecord>;
  /** Base URL of the running server, such as `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  readonly transcodeDir: string;
  readonly fileId: (library: "movies" | "shows", relativePath: string) => MediaFileId;
}

/** The running test server. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/test/MediaTestServer",
) {}

const MOVIES = LibraryId.make("movies");

const SHOWS = LibraryId.make("shows");

interface Options {
  readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem;
  /**
   * Runs as in Convex mode against `TestConvex`, with the real session reports and ended-session
   * registry over its subscriptions. Standalone, with no session reports and no session ever
   * ended, when absent; the scripted Convex is then present but nothing follows it.
   */
  readonly convex?: true;
}

/**
 * Builds the server with extra environment `overrides` (for example `STREAM_IDLE_SECONDS`).
 * The fixture workspace is approved as the only library root.
 */
export const layer = (overrides: Readonly<Record<string, string>> = {}, options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const workspace = yield* FixtureWorkspace.Service;
      const path = yield* Path.Path;
      const transcodeDir = path.join(workspace.root, "transcode");

      const config = testConfigLayer({
        LIBRARY_ROOTS: workspace.root,
        DATA_DIR: path.join(workspace.root, "data"),
        TRANSCODE_DIR: transcodeDir,
        MEDIA_BASE_URL: "http://media.test",
        MIN_FREE_TRANSCODE_MB: "1",
        ...overrides,
      });

      const logged: Array<LogRecord> = [];

      const logging = Layer.mergeAll(
        Logger.layer(
          [
            Logger.map(redactedLine, (line) => {
              logged.push(...Option.toArray(decodeRecord(line)));
            }),
          ],
          { mergeWithExisting: true },
        ),
        Layer.effect(
          References.MinimumLogLevel,
          Effect.map(MediaConfig.Service, (settings) => settings.logs.level),
        ).pipe(Layer.provide(config)),
      );

      const reports =
        options.convex === true
          ? EndedSessions.layer.pipe(Layer.provideMerge(ConvexSessionReports.layer))
          : Layer.merge(SessionReports.layerNone, EndedSessions.layerNone);

      const fileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, options.fileSystem ?? ((real) => real)),
      );

      const services = servicesLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            MemoryLibrary.layer,
            PlaybackReporter.layerRecording,
            BackendHealth.layerStandalone,
            reports,
          ),
        ),
        Layer.provideMerge(TestConvex.layer),
        Layer.provideMerge(config),
        Layer.provide(fileSystem),
      );

      const server = serve(routesLayer.pipe(Layer.provide(fileSystem))).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      );

      const ready = Layer.effect(
        Service,
        Effect.gen(function* () {
          const scanner = yield* LibraryScanner.Service;

          for (const [libraryId, root] of [
            [MOVIES, workspace.library.moviesRoot],
            [SHOWS, workspace.library.showsRoot],
          ] as const) {
            yield* scanner.scan({ libraryId, root, mode: "incremental" }).pipe(Effect.orDie);
          }

          return yield* HttpServer.addressFormattedWith((baseUrl) =>
            Effect.succeed(
              Service.of({
                logged: () => logged,
                baseUrl,
                transcodeDir,
                fileId: (name, relativePath) =>
                  MemoryLibrary.fileIdOf(name === "movies" ? MOVIES : SHOWS, relativePath),
              }),
            ),
          );
        }),
      );

      return ready.pipe(
        Layer.provideMerge(server),
        Layer.provideMerge(services),
        Layer.provide(logging),
      );
    }),
  ).pipe(
    Layer.provideMerge(FixtureWorkspace.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
