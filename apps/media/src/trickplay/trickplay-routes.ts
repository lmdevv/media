import { PlaybackSessionEnded } from "@media/contracts/media-playback";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { Effect, Layer, Match, Option, Schema } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { playbackTokenOf } from "../http/playback-token-param.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as TrickplayStore from "./trickplay-store.ts";

class TrickplayAccessDenied extends Schema.TaggedError<TrickplayAccessDenied>()(
  "TrickplayAccessDenied",
  {},
) {
  override get message(): string {
    return "Trickplay access denied: the token is for another file";
  }
}

class TrickplayNotFound extends Schema.TaggedError<TrickplayNotFound>()("TrickplayNotFound", {}) {
  override get message(): string {
    return "Trickplay not found";
  }
}

const RouteError = Schema.Union([
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  TrickplayAccessDenied,
  TrickplayNotFound,
]);

type RouteError = typeof RouteError.Type;

const encodeRouteError = Schema.encodeEffect(Schema.toCodecJson(RouteError));

const statusOf = Match.valueTags<RouteError, Record<RouteError["_tag"], () => number>>({
  PlaybackTokenInvalid: () => 401,
  PlaybackSessionEnded: () => 410,
  TrickplayAccessDenied: () => 403,
  TrickplayNotFound: () => 404,
});

const CACHE_CONTROL = "private, max-age=31536000, immutable";

const errorResponse = (error: RouteError) =>
  encodeRouteError(error).pipe(
    Effect.orDie,
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(body, {
        status: statusOf(error),
        headers: { "cache-control": "no-store" },
      }),
    ),
  );

/** Adds the route. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | PlaybackToken.Service | TrickplayStore.Service | HttpPlatform.HttpPlatform
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const verifier = yield* PlaybackToken.Service;
    const store = yield* TrickplayStore.Service;
    const platform = yield* HttpPlatform.HttpPlatform;

    const thumbnails = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { fileId = "", version = "", name = "" } = yield* HttpRouter.params;

      const grant = yield* verifier.verify(
        yield* playbackTokenOf(request, verifier.param),
        PlaybackToken.PLAY,
        PlaybackToken.READ,
      );

      if (grant.fileId !== fileId) return yield* new TrickplayAccessDenied();
      const stored = yield* store.find(fileId, version, name);

      if (Option.isNone(stored)) return yield* new TrickplayNotFound();

      return yield* platform
        .fileResponse(stored.value, {
          headers: {
            "content-type": name.endsWith(".json") ? "application/json" : "image/jpeg",
            "cache-control": CACHE_CONTROL,
          },
        })
        .pipe(Effect.mapError(() => new TrickplayNotFound()));
    }).pipe(Effect.catch(errorResponse), Effect.withSpan("TrickplayRoutes.file"));

    yield* router.add("GET", "/media/trickplay/:fileId/:version/:name", thumbnails);
  }),
);
