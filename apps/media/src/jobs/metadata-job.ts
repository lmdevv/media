import type { LibraryId } from "@media/contracts/ids";
import type { Artwork, ExternalIds, TitleKind } from "@media/contracts/models/catalog";
import type { ScannedEpisode } from "@media/contracts/models/scan";
import { Effect, Match, Option } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import { toScannedEpisode, toScannedTitle } from "../core/catalog-records.ts";
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
import { JobFailed } from "../core/core-jobs.ts";

const noActorImages = (): undefined => undefined;

const remote = (url: string | undefined) =>
  url === undefined ? undefined : ImageRef.cases.Remote.make({ url });

/** How a metadata provider's failure ends a job: retried only when the request may work later. */
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

/** What a metadata lookup needs of a title: its names and ids, artwork, and episodes. */
export interface LookupTarget<EpisodeKey> {
  readonly libraryId: LibraryId;
  readonly kind: TitleKind;
  readonly name: string;
  readonly year: number | null;
  readonly externalIds: ExternalIds;
  readonly artwork: Artwork;
  readonly episodes: ReadonlyArray<{
    readonly episodeId: EpisodeKey;
    readonly seasonNumber: number;
    readonly episodeNumber: number;
  }>;
}

/**
 * Looks a title up at the metadata provider, by the match an admin chose when there is one, and
 * shapes what it found as catalog records. Fails with `JobFailed` when nothing matches.
 */
export const lookUp = Effect.fn("MetadataJob.lookUp")(function* <EpisodeKey>(
  target: LookupTarget<EpisodeKey>,
  chosen: Option.Option<string>,
) {
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;
  const omdb = yield* Omdb.Service;

  const providerIdOf = Effect.gen(function* () {
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

  const providerId = yield* providerIdOf.pipe(Effect.mapError(providerFailure));

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
    readonly episodeId: EpisodeKey;
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

  return { providerId: providerId.value, details, metadata, folder, title, fetched, episodes };
});

/** The top-billed people whose details a metadata job fetches itself. */
export const TOP_BILLED = 10;
