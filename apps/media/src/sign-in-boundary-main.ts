/**
 * The sign-in boundary alone, for the development stack (`scripts/dev-stack.sh`): the media
 * service's own `SIGN_IN_PATH` route on `HOST`:`PORT`, relaying to the core at `CONVEX_URL` with
 * passes from `MEDIA_TICKET_KEYS`. The stack suites and the web clients' development servers sign
 * in through it, so none of them needs the core's refusal turned off and none needs a running
 * media service.
 */
import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";

import * as HttpServer from "./http/http-server.ts";
import * as Outbound from "./http/outbound.ts";
import * as SignInBoundary from "./http/sign-in-boundary.ts";
import * as SignInPasses from "./http/sign-in-passes.ts";

const boundary = Layer.unwrap(
  Effect.gen(function* () {
    const coreUrl = yield* Config.NonEmptyString("CONVEX_URL");
    const ticketKeys = yield* Config.Redacted("MEDIA_TICKET_KEYS");
    const port = yield* Config.Port("PORT");
    const host = yield* Config.NonEmptyString("HOST").pipe(Config.withDefault("127.0.0.1"));

    return HttpServer.serve(
      Layer.mergeAll(SignInBoundary.layer({ coreUrl }), HttpServer.cors),
    ).pipe(
      Layer.provide(SignInPasses.layer(ticketKeys)),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
    );
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Outbound.layer)));

Layer.launch(boundary).pipe(NodeRuntime.runMain);
