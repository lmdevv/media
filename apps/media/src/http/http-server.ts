import { createServer, ServerResponse } from "node:http";

import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { MusicStreamTimingHeader } from "@media/contracts/music-playback";
import { Duration, Effect, Layer, Option } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

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
  allowedHeaders: [
    "authorization",
    "content-type",
    "range",
    "if-range",
    "if-none-match",
    "x-request-id",
  ],
  exposedHeaders: [
    "content-range",
    "content-length",
    "accept-ranges",
    "etag",
    "retry-after",
    "x-request-id",
    ...Object.values(MusicStreamTimingHeader).map((header) => header.toLowerCase()),
  ],
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

/** The paths whose URLs carry tickets: movies' and music's media bytes, and music's art. */
const TICKETED_PATHS = ["/media/", "/music/"] as const;

/**
 * Whether Effect's automatic server span may record request URL `url`: never for `/media/` and
 * `/music/`, whose URLs carry tickets, and never for a URL the span would read with another host,
 * as it reads `//invite/<code>` or `/\invite/<code>`, exporting the code as the whole path.
 */
export const tracesRequest = (url: string): boolean => {
  const parsed = URL.parse(url, SPAN_BASE);

  return (
    parsed !== null &&
    parsed.origin === SPAN_BASE &&
    !TICKETED_PATHS.some((prefix) => parsed.pathname.startsWith(prefix))
  );
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
 * Ends the response to a `HEAD` whose client has gone, so the server finds it sent. Effect 4.0.3's
 * Node server answers a `HEAD` by waiting until its response finishes or closes, and once the client
 * has left neither happens: the request's fiber, interrupted by that leaving, then waits for ever
 * where it cannot be interrupted, and the server never finishes stopping (`effect@4.0.7` returns
 * at once for a destroyed response). This runs inside the router, before the server writes.
 */
const headsOfLeftClients = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.method !== "HEAD") return yield* httpEffect;

      // Undefined, whatever its type says, for a request Node's server did not make.
      const response: unknown = NodeHttpServerRequest.toServerResponse(request);

      if (!(response instanceof ServerResponse)) return yield* httpEffect;

      const endIfLeft = () => {
        if (!response.writableEnded) response.end();
      };

      // Now if the client already left, else when it leaves: by then the server's own listener has
      // interrupted the request, and this one ends the response before the server writes and waits.
      return yield* httpEffect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (response.destroyed) endIfLeft();
            else response.once("close", endIfLeft);
          }),
        ),
      );
    }),
  { global: true },
);

/**
 * `routes` served over the `HttpServer` in context, the way the service serves every request:
 * Effect's INFO request logger off and the DEBUG `accessLog` in its place, and a `HEAD` whose
 * client left never holding up a shutdown.
 */
export const serve = <E, R>(routes: Layer.Layer<never, E, R>) =>
  HttpRouter.serve(Layer.mergeAll(routes, headsOfLeftClients), {
    disableLogger: true,
    middleware: accessLog,
  }).pipe(Layer.provide(tokenSafeTracing));

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
