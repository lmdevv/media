import { ArtworkWidth } from "@media/contracts/artwork";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ArtworkGate from "../artwork/artwork-gate.ts";
import * as ArtworkStore from "../artwork/artwork-store.ts";

const decodeWidth = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ArtworkWidth)),
);

const CACHE_CONTROL = "public, max-age=86400";

/** Adds the artwork route. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | ArtworkStore.Service | HttpPlatform.HttpPlatform
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const store = yield* ArtworkStore.Service;
    const platform = yield* HttpPlatform.HttpPlatform;
    const gate = yield* Effect.serviceOption(ArtworkGate.Service);

    const artwork = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      // A wildcard, not `:key`: the router refuses path parameters over 100 characters.
      const { "*": key = "" } = yield* HttpRouter.params;
      const raw = new URL(request.url, "http://media.invalid").searchParams.get("w");

      const width =
        raw === null ? Option.some(Option.none()) : Option.map(decodeWidth(raw), Option.some);

      if (Option.isNone(width)) return HttpServerResponse.empty({ status: 400 });

      // On the core, an image needs a shareable ticket for its key (ADR 0011).
      if (Option.isSome(gate)) {
        const ticket = new URL(request.url, "http://media.invalid").searchParams.get(
          gate.value.param,
        );

        if (ticket === null || !(yield* gate.value.admits(ticket, key))) {
          return HttpServerResponse.empty({ status: 401 });
        }
      }

      const image = yield* store.image(key, width.value);

      return yield* platform.fileResponse(image.path, {
        headers: { "content-type": image.contentType, "cache-control": CACHE_CONTROL },
      });
    }).pipe(
      Effect.catchTags({
        ArtworkNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ArtworkUnavailable: (error) =>
          Effect.logWarning("ArtworkRoutes.unavailable", error).pipe(
            Effect.as(HttpServerResponse.empty({ status: 503 })),
          ),
        PlatformError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      }),
      Effect.withSpan("ArtworkRoutes.image"),
    );

    yield* router.add("GET", "/artwork/*", artwork);
  }),
);
