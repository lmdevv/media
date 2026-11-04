import type { ScannedEpisode } from "@media/contracts/models/scan";
import type { FunctionResult } from "../convex/media-backend.ts";
import { Effect, Match, Option } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import {
  digestOf,
  toScannedCollection,
  toScannedCredits,
  toScannedEpisode,
  toScannedTitle,
} from "../convex/catalog-records.ts";
import * as MediaBackend from "../convex/media-backend.ts";
import type { SiteRatings } from "../library/nfo.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import type {
  ProviderCollection,
  ProviderSeason,
  ProviderTitle,
} from "../metadata/metadata-plugin.ts";
import * as Omdb from "../metadata/omdb.ts";
import {
  bestMatch,
  ImageRef,
  mergeCollection,
  mergeCredits,
  mergeRatings,
} from "../metadata/title-metadata.ts";
import type { EpisodeMetadata, TitleMetadata } from "../metadata/title-metadata.ts";
import { JobFailed, type JobHandler } from "./job-worker.ts";
import { personDetailsOf } from "./person-job.ts";

const EPISODE_BATCH = 100;

const TOP_BILLED = 10;

const noActorImages = (): undefined => undefined;

const remote = (url: string | undefined) =>
  url === undefined ? undefined : ImageRef.cases.Remote.make({ url });

const providerFailure = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MetadataRequestFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    PluginPermissionDenied: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

const titleMetadataOf = (
  title: ProviderTitle,
  scores: SiteRatings,
  collection: ProviderCollection | undefined,
): TitleMetadata => ({
  kind: title.kind,
  title: title.title,
  originalTitle: title.originalTitle,
  year: title.year,
  releaseDate: title.releaseDate,
  plot: title.plot,
  tagline: title.tagline,
  runtimeMinutes: title.runtimeMinutes,
  contentRating: title.contentRating,
  ratings: mergeRatings(undefined, scores, title.rating),
  genres: title.genres,
  studios: title.studios,
  countries: title.countries,
  tags: title.tags,
  originalLanguage: title.originalLanguage,
  status: title.status,
  trailer: title.trailer,
  collection: mergeCollection(undefined, collection ?? title.collection),
  recommendations: title.recommendations,
  credits: mergeCredits(undefined, title.credits, noActorImages, "actor"),
  ids: { ...title.ids, tmdb: title.providerId },
  poster: remote(title.images.poster),
  backdrop: remote(title.images.backdrop),
  sources: ["provider"],
});

const episodeMetadataOf = (season: ProviderSeason, episode: number): EpisodeMetadata => {
  const found = season.episodes.find((candidate) => candidate.episode === episode);

  return {
    season: season.season,
    episodes: [episode],
    title: found?.title,
    plot: found?.plot,
    airDate: found?.airDate,
    runtimeMinutes: found?.runtimeMinutes,
    rating: found?.rating,
    ids: found?.ids ?? {},
    seasonIds: season.ids,
    credits: mergeCredits(undefined, found?.credits ?? [], noActorImages, "guest-star"),
    still: remote(found?.images.still),
    seasonPoster: remote(season.images.poster),
    sources: ["provider"],
  };
};

const backendFailure = (error: { readonly message: string }) =>
  new JobFailed({ message: error.message, retry: true });

/** The metadata job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  MediaBackend.Service | MetadataPlugin.Service | ArtworkKeys.Service | Omdb.Service
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;
  const omdb = yield* Omdb.Service;

  const providerIdOf = Effect.fn("MetadataJob.providerId")(function* (
    target: FunctionResult<"mediaService.metadataTarget">,
    chosen: Option.Option<string>,
  ) {
    if (Option.isSome(chosen)) return Option.some(chosen.value);

    if (target.externalIds.tmdb !== null) return Option.some(target.externalIds.tmdb);

    const ids = {
      imdb: target.externalIds.imdb ?? undefined,
      tvdb: target.externalIds.tvdb ?? undefined,
    };

    const byId = yield* plugin.findByExternalId(target.kind, ids);

    if (byId !== undefined) return Option.some(byId);

    const query = { kind: target.kind, title: target.name, year: target.year ?? undefined, ids };

    return Option.fromUndefinedOr(bestMatch(query, yield* plugin.search(query))?.providerId);
  });

  return {
    kind: "metadata",
    run: Effect.fn("MetadataJob.run")(function* (claim, workerId, reportProgress) {
      const { payload } = claim.job;

      if (payload.kind !== "metadata") {
        return yield* new JobFailed({ message: "This is not a metadata job", retry: false });
      }

      const target = yield* backend
        .call("mediaService.metadataTarget", { titleId: payload.titleId })
        .pipe(Effect.mapError(backendFailure));

      const providerId = yield* providerIdOf(
        target,
        Option.fromNullOr(payload.match).pipe(Option.map((match) => match.providerId)),
      ).pipe(Effect.mapError(providerFailure));

      if (Option.isNone(providerId)) {
        return yield* new JobFailed({
          message: `No metadata match for ${target.name}; choose one with metadata.fixMatch`,
          retry: false,
        });
      }

      const details = yield* plugin
        .titleDetails(target.kind, providerId.value)
        .pipe(Effect.mapError(providerFailure));

      const collection =
        details.collection === undefined
          ? undefined
          : yield* plugin
              .collectionDetails(details.collection.providerId)
              .pipe(Effect.orElseSucceed(() => undefined));

      const imdb = details.ids.imdb ?? target.externalIds.imdb ?? undefined;
      const scores = imdb === undefined ? {} : yield* omdb.ratings(imdb);
      const metadata = titleMetadataOf(details, scores, collection);
      const folder = { libraryId: target.libraryId, root: "" };
      const scanned = yield* toScannedTitle(folder, metadata, keys.seal);

      const title = {
        ...scanned,
        artwork: {
          poster: scanned.artwork.poster ?? target.artwork.poster,
          backdrop: scanned.artwork.backdrop ?? target.artwork.backdrop,
          logo: scanned.artwork.logo ?? target.artwork.logo,
        },
      };

      const seasons = [...new Set(target.episodes.map((episode) => episode.seasonNumber))];

      const fetched: ReadonlyArray<{
        readonly episodeId: (typeof target.episodes)[number]["episodeId"];
        readonly metadata: EpisodeMetadata;
      }> =
        target.kind === "show"
          ? yield* Effect.forEach(seasons, (season) =>
              plugin.seasonDetails(providerId.value, season).pipe(
                Effect.map((seasonDetails) =>
                  target.episodes
                    .filter((episode) => episode.seasonNumber === season)
                    .map((episode) => ({
                      episodeId: episode.episodeId,
                      metadata: episodeMetadataOf(seasonDetails, episode.episodeNumber),
                    })),
                ),
                Effect.catchTag("MetadataRequestFailed", () => Effect.succeed([])),
                Effect.mapError(providerFailure),
              ),
            ).pipe(Effect.map((perSeason) => perSeason.flat()))
          : [];

      const episodes: Array<ScannedEpisode> = yield* Effect.forEach(fetched, (episode) =>
        toScannedEpisode(folder, episode.metadata, keys.seal),
      );

      const batches = Array.from(
        { length: Math.max(1, Math.ceil(episodes.length / EPISODE_BATCH)) },
        (_, index) => episodes.slice(index * EPISODE_BATCH, (index + 1) * EPISODE_BATCH),
      );

      yield* Effect.forEach(
        batches,
        (batch, index) =>
          backend
            .call("mediaService.applyMetadata", {
              jobId: claim.job.id,
              workerId,
              titleId: target.titleId,
              title,
              episodes: batch,
            })
            .pipe(
              Effect.mapError(backendFailure),
              Effect.andThen(
                reportProgress({ done: index + 1, total: batches.length, message: "writing" }),
              ),
            ),
        { discard: true },
      );

      const lease = { jobId: claim.job.id, workerId };

      const writeCredits = (
        episodeId: (typeof fetched)[number]["episodeId"] | null,
        credits: TitleMetadata["credits"],
      ) =>
        Effect.gen(function* () {
          const scannedCredits = yield* toScannedCredits(folder, credits, keys.seal);

          const written = yield* backend.call("mediaService.applyCredits", {
            titleId: target.titleId,
            episodeId,
            credits: scannedCredits,
            hash: digestOf(scannedCredits),
            lease,
          });

          return written.people;
        });

      const cast = yield* writeCredits(null, metadata.credits).pipe(
        Effect.mapError(backendFailure),
      );

      const scannedCollection = yield* toScannedCollection(folder, metadata.collection, keys.seal);

      yield* backend
        .call("mediaService.applyCollection", {
          titleId: target.titleId,
          collection: scannedCollection,
          hash: digestOf(scannedCollection),
          lease,
        })
        .pipe(Effect.mapError(backendFailure));

      yield* Effect.forEach(
        fetched,
        (episode) => writeCredits(episode.episodeId, episode.metadata.credits),
        { discard: true },
      ).pipe(Effect.mapError(backendFailure));

      yield* Effect.forEach(
        cast
          .slice(0, TOP_BILLED)
          .flatMap((person) =>
            person.needsDetails && person.tmdbId !== null ? [{ person, tmdb: person.tmdbId }] : [],
          ),
        ({ person, tmdb }) =>
          plugin.personDetails(tmdb).pipe(
            Effect.flatMap((found) => personDetailsOf(found, keys.seal)),
            Effect.flatMap((personDetails) =>
              backend.call("mediaService.applyPerson", {
                ...lease,
                personId: person.personId,
                details: personDetails,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("MetadataJob.person_failed", error.message).pipe(
                Effect.annotateLogs({ personId: person.personId }),
              ),
            ),
          ),
        { discard: true },
      );

      return `Matched to TMDB ${providerId.value}: ${details.title}${details.year === undefined ? "" : ` (${String(details.year)})`}`;
    }),
  } satisfies JobHandler;
});
