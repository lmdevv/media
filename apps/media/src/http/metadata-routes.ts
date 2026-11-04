import { Internal, RateLimited } from "@media/contracts/errors";
import type { MetadataCandidate } from "@media/contracts/models/catalog";
import { Effect, Layer, Match } from "effect";
import type { HttpRouter } from "effect/http";

import * as MediaBackend from "../convex/media-backend.ts";
import type * as ViewerAuth from "../convex/viewer-auth.ts";
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
  HttpRouter.HttpRouter | ViewerAuth.Service | MediaBackend.Service | MetadataPlugin.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend.Service;
    const plugin = yield* MetadataPlugin.Service;

    yield* commandRoute(
      "metadata.searchCandidates",
      Effect.fn("MetadataRoutes.searchCandidates")(function* ({ titleId, query, year }) {
        const target = yield* backend.call("mediaService.metadataTarget", { titleId });

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
