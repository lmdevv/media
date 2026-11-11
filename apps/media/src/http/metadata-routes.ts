import { Internal, RateLimited } from "@media/contracts/errors";
import type { MetadataCandidate } from "@media/contracts/models/catalog";
import { serverFunctions } from "@media/contracts/server-functions";
import { Effect, Layer, Match } from "effect";
import type { HttpRouter } from "effect/http";

import type * as CoreCallers from "../core/core-callers.ts";
import * as CoreSession from "../core/core-session.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import { commandRoute } from "./command-routes.ts";

const MAX_CANDIDATES = 20;

const providerFailure = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: () =>
      new Internal({ message: "No metadata provider is configured; set TMDB_API_KEY" }),
    MetadataRequestFailed: (error) =>
      error.status === 429
        ? new RateLimited({ message: "The metadata provider is rate limiting; retry shortly" })
        : new Internal({ message: `The metadata provider failed: ${error.detail}` }),
    PluginPermissionDenied: (error) => new Internal({ message: error.message }),
  }),
);

/** Adds the metadata command routes. */
export const layer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | CoreCallers.Service | CoreSession.Service | MetadataPlugin.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const core = yield* CoreSession.Service;
    const plugin = yield* MetadataPlugin.Service;

    yield* commandRoute(
      "metadata.searchCandidates",
      Effect.fn("MetadataRoutes.searchCandidates")(function* ({ titleId, query, year }) {
        const target = yield* core.call(serverFunctions.metadataTarget, { titleId, cursor: null });

        if (MetadataPlugin.PluginAvailability.guards.Unavailable(yield* plugin.availability)) {
          return yield* new Internal({
            message: "No metadata provider is configured; set TMDB_API_KEY",
          });
        }

        const matches = yield* plugin
          .search({ kind: target.kind, title: query, year, ids: {} })
          .pipe(Effect.mapError(providerFailure));

        return matches.slice(0, MAX_CANDIDATES).map((match): MetadataCandidate => ({
          provider: "tmdb",
          providerId: match.providerId,
          kind: match.kind,
          name: match.title,
          year: match.year ?? null,
          overview: match.overview ?? null,
          posterUrl: match.poster ?? null,
        }));
      }),
    );
  }),
);
