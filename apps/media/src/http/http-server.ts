import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Duration, Effect, Layer, Option } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";

import * as MediaConfig from "../media-config.ts";
import * as TrickplayRoutes from "../trickplay/trickplay-routes.ts";
import { accessLog } from "./access-log.ts";
import { apiLayer } from "./api-handlers.ts";
import * as ArtworkRoutes from "./artwork-routes.ts";
import * as Hardening from "./hardening.ts";
import * as MediaRoutes from "./media-routes.ts";
import * as RateLimit from "./rate-limit.ts";
import * as WebApp from "./web-app.ts";

/** Lets the web clients call the service from another origin, as in development. */
export const cors = HttpRouter.cors({
  allowedOrigins: ["*"],
  allowedHeaders: ["authorization", "content-type", "range", "x-request-id"],
  exposedHeaders: ["content-range", "content-length", "accept-ranges", "x-request-id"],
});

/** Every route the service answers. */
export const routesLayer = Layer.mergeAll(
  apiLayer,
  MediaRoutes.layer,
  TrickplayRoutes.layer,
  ArtworkRoutes.layer,
  WebApp.layer,
  Hardening.layer,
  RateLimit.layer,
  cors,
);

const SPAN_BASE = "http://media.invalid";

/**
 * Whether Effect's automatic server span may record request URL `url`: never for `/media/`, whose
 * URLs carry playback tokens, and never for a URL the span would read with another host, as it
 * reads `//invite/<code>` or `/\invite/<code>`, exporting the code as the whole path.
 */
export const tracesRequest = (url: string): boolean => {
  const parsed = URL.parse(url, SPAN_BASE);

  return parsed !== null && parsed.origin === SPAN_BASE && !parsed.pathname.startsWith("/media/");
};

const tokenSafeTracing = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request) => !tracesRequest(request.url),
);

/**
 * How long a shutdown waits for open responses before it ends them. API calls answer in
 * milliseconds and a segment reaches a player on the LAN well within a second, so what is still
 * open after this is a long transfer, such as a direct-play file, a download, or a followed log,
 * which its client resumes with a range request or a new follow. Effect's default, 20 s, let one
 * viewer hold every restart.
 */
const SHUTDOWN_GRACE = Duration.seconds(3);

/**
 * `routes` served over the `HttpServer` in context, the way the service serves every request:
 * Effect's INFO request logger off and the DEBUG `accessLog` in its place.
 */
export const serve = <E, R>(routes: Layer.Layer<never, E, R>) =>
  HttpRouter.serve(routes, { disableLogger: true, middleware: accessLog }).pipe(
    Layer.provide(tokenSafeTracing),
  );

/**
 * Serves the common routes plus `commandRoutes` (route groups of registry `media` commands, which
 * need Convex) on `HOST`:`PORT`.
 */
export const layer = <E, R>(commandRoutes: Layer.Layer<never, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MediaConfig.Service;

      return serve(Layer.mergeAll(routesLayer, commandRoutes)).pipe(
        Layer.provide(
          NodeHttpServer.layer(createServer, {
            port: config.port,
            host: Option.getOrUndefined(config.host),
            gracefulShutdownTimeout: SHUTDOWN_GRACE,
          }),
        ),
      );
    }),
  );
