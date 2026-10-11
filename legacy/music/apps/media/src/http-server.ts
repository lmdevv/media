/** Serves the media HTTP API on `PORT` for the lifetime of the layer. */
import { serve } from "@hono/node-server";
import { Effect, Layer } from "effect";

import { makeHttpApp } from "./http-app.ts";
import type { MediaBackend } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import type { Transcoder } from "./transcoder.ts";

/** Starts the HTTP server and closes it when the layer is released. */
export const layer: Layer.Layer<never, never, MediaBackend | MediaConfig | Transcoder> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MediaConfig;
      const app = yield* makeHttpApp;

      yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof serve>>((resume) => {
          const server = serve({ fetch: app.fetch, port: config.port }, () => {
            resume(Effect.succeed(server));
          });
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => {
              resume(Effect.void);
            });
          }),
      );

      yield* Effect.logInfo("Http.listening").pipe(Effect.annotateLogs({ port: config.port }));
    }),
  );
