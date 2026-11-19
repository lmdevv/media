/**
 * The in-repo TMDB metadata plugin. It accepts either a v3 API key (sent as the `api_key` query
 * parameter) or a v4 read access token (sent as a bearer token). Responses are cached on disk,
 * requests are paced by a rate limiter that also honours `429 Retry-After`, and Effect's client
 * spans are disabled for these requests because their URLs may carry the key; each operation
 * records its own span with the request path only.
 */
import { Duration, Effect, identity, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RateLimiter } from "effect/persistence";

import { type ExternalIds, type Score, showStatusOf, youtubeKeyOf } from "../library/nfo.ts";
import * as MediaConfig from "../media-config.ts";
import * as DiskCache from "../disk-cache.ts";
import {
  guardHosts,
  MetadataProviderUnavailable,
  MetadataRequestFailed,
  type CreditKind,
  type PluginManifest,
  type ProviderCollection,
  type ProviderCredit,
  type ProviderEpisode,
  type ProviderImages,
  type ProviderPerson,
  type ProviderSeason,
  type ProviderTitle,
  Service,
  type TitleKind,
  type TitleMatch,
  type TitleQuery,
} from "./metadata-plugin.ts";

/** How the TMDB plugin reaches TMDB. */
export interface TmdbOptions {
  /** v3 API key or v4 read access token; absent makes the plugin report itself unavailable. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /** API root, `https://api.themoviedb.org/3` in production. */
  readonly apiBaseUrl: string;
  /** Image root used to build poster, backdrop, and still URLs. */
  readonly imageBaseUrl: string;
  /** Response language, such as `en-US`. */
  readonly language: string;
  readonly cacheMaxAge: Duration.Duration;
  /** How long one request may take, including retries after `429`. */
  readonly timeout: Duration.Duration;
  /** Request budget per second, shared by every TMDB request of this process. */
  readonly requestsPerSecond: number;
  /** Longest one request may take, from sending it to reading its body. */
  readonly requestTimeout: Duration.Duration;
}

/** Production TMDB endpoints with a one-week cache and a conservative request budget. */
export const defaultOptions = (apiKey: Option.Option<Redacted.Redacted>): TmdbOptions => ({
  apiKey,
  apiBaseUrl: "https://api.themoviedb.org/3",
  imageBaseUrl: "https://image.tmdb.org/t/p",
  language: "en-US",
  cacheMaxAge: Duration.days(7),
  timeout: Duration.seconds(20),
  requestsPerSecond: 20,
  requestTimeout: Duration.seconds(15),
});

const PROVIDER = "tmdb";

const NamedList = Schema.Array(Schema.Struct({ name: Schema.String }));

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const SearchMovies = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      title: Schema.String,
      release_date: nullable(Schema.String),
      overview: nullable(Schema.String),
      poster_path: nullable(Schema.String),
    }),
  ),
});

const SearchShows = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      first_air_date: nullable(Schema.String),
      overview: nullable(Schema.String),
      poster_path: nullable(Schema.String),
    }),
  ),
});

const IdList = Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.Int })) });

const Videos = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      site: Schema.String,
      type: Schema.String,
      name: nullable(Schema.String),
      official: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const Countries = Schema.Array(Schema.Struct({ name: Schema.String }));

const CastMember = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  character: nullable(Schema.String),
  order: nullable(Schema.Int),
  profile_path: nullable(Schema.String),
});

const CrewMember = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  job: nullable(Schema.String),
  department: nullable(Schema.String),
  profile_path: nullable(Schema.String),
});

const FindResults = Schema.Struct({
  movie_results: Schema.Array(Schema.Struct({ id: Schema.Int })),
  tv_results: Schema.Array(Schema.Struct({ id: Schema.Int })),
});

const MovieDetails = Schema.Struct({
  id: Schema.Int,
  imdb_id: nullable(Schema.String),
  title: Schema.String,
  original_title: nullable(Schema.String),
  overview: nullable(Schema.String),
  tagline: nullable(Schema.String),
  release_date: nullable(Schema.String),
  runtime: nullable(Schema.Int),
  genres: Schema.optionalKey(NamedList),
  production_companies: Schema.optionalKey(NamedList),
  vote_average: nullable(Schema.Finite),
  vote_count: nullable(Schema.Int),
  original_language: nullable(Schema.String),
  production_countries: Schema.optionalKey(Countries),
  poster_path: nullable(Schema.String),
  backdrop_path: nullable(Schema.String),
  belongs_to_collection: nullable(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      poster_path: nullable(Schema.String),
      backdrop_path: nullable(Schema.String),
    }),
  ),
  credits: Schema.optionalKey(
    Schema.Struct({ cast: Schema.Array(CastMember), crew: Schema.Array(CrewMember) }),
  ),
  keywords: Schema.optionalKey(Schema.Struct({ keywords: NamedList })),
  videos: Schema.optionalKey(Videos),
  recommendations: Schema.optionalKey(IdList),
  similar: Schema.optionalKey(IdList),
  release_dates: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          iso_3166_1: Schema.String,
          release_dates: Schema.Array(Schema.Struct({ certification: Schema.String })),
        }),
      ),
    }),
  ),
});

const ShowDetails = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  original_name: nullable(Schema.String),
  overview: nullable(Schema.String),
  tagline: nullable(Schema.String),
  first_air_date: nullable(Schema.String),
  episode_run_time: Schema.optionalKey(Schema.Array(Schema.Int)),
  genres: Schema.optionalKey(NamedList),
  networks: Schema.optionalKey(NamedList),
  vote_average: nullable(Schema.Finite),
  vote_count: nullable(Schema.Int),
  original_language: nullable(Schema.String),
  production_countries: Schema.optionalKey(Countries),
  status: nullable(Schema.String),
  poster_path: nullable(Schema.String),
  backdrop_path: nullable(Schema.String),
  created_by: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Schema.Int, name: Schema.String, profile_path: nullable(Schema.String) }),
    ),
  ),
  aggregate_credits: Schema.optionalKey(
    Schema.Struct({
      cast: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          order: nullable(Schema.Int),
          profile_path: nullable(Schema.String),
          roles: Schema.optionalKey(
            Schema.Array(Schema.Struct({ character: nullable(Schema.String) })),
          ),
        }),
      ),
      crew: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          department: nullable(Schema.String),
          profile_path: nullable(Schema.String),
          total_episode_count: nullable(Schema.Int),
          jobs: Schema.optionalKey(Schema.Array(Schema.Struct({ job: nullable(Schema.String) }))),
        }),
      ),
    }),
  ),
  keywords: Schema.optionalKey(Schema.Struct({ results: NamedList })),
  videos: Schema.optionalKey(Videos),
  recommendations: Schema.optionalKey(IdList),
  similar: Schema.optionalKey(IdList),
  external_ids: Schema.optionalKey(
    Schema.Struct({ imdb_id: nullable(Schema.String), tvdb_id: nullable(Schema.Int) }),
  ),
  content_ratings: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ iso_3166_1: Schema.String, rating: Schema.String })),
    }),
  ),
});

const EpisodeDetails = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  season_number: Schema.Int,
  episode_number: Schema.Int,
  name: nullable(Schema.String),
  overview: nullable(Schema.String),
  air_date: nullable(Schema.String),
  runtime: nullable(Schema.Int),
  vote_average: nullable(Schema.Finite),
  vote_count: nullable(Schema.Int),
  still_path: nullable(Schema.String),
  crew: Schema.optionalKey(Schema.Array(CrewMember)),
  guest_stars: Schema.optionalKey(Schema.Array(CastMember)),
});

const SeasonDetails = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  season_number: Schema.Int,
  name: nullable(Schema.String),
  overview: nullable(Schema.String),
  air_date: nullable(Schema.String),
  poster_path: nullable(Schema.String),
  episodes: Schema.Array(EpisodeDetails),
});

const CollectionDetails = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  overview: nullable(Schema.String),
  poster_path: nullable(Schema.String),
  backdrop_path: nullable(Schema.String),
});

const PersonDetails = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  biography: nullable(Schema.String),
  birthday: nullable(Schema.String),
  deathday: nullable(Schema.String),
  place_of_birth: nullable(Schema.String),
  known_for_department: nullable(Schema.String),
  profile_path: nullable(Schema.String),
  imdb_id: nullable(Schema.String),
  external_ids: Schema.optionalKey(Schema.Struct({ tvdb_id: nullable(Schema.Int) })),
});

const CAST_LIMIT = 20;

const GUEST_LIMIT = 10;

/** Trailer languages: English, and videos without a language. */
const VIDEO_LANGUAGES = "en,null";

const RECOMMENDATION_LIMIT = 20;

const TAG_LIMIT = 40;

const CREW_JOBS: ReadonlyArray<{
  readonly kind: CreditKind;
  readonly limit: number;
  readonly matches: (job: string, department: string) => boolean;
}> = [
  { kind: "director", limit: 3, matches: (job) => job === "Director" },
  {
    kind: "writer",
    limit: 6,
    matches: (job, department) => department === "Writing" && job !== "Staff Writer",
  },
  { kind: "producer", limit: 4, matches: (job) => job === "Producer" },
  {
    kind: "composer",
    limit: 2,
    matches: (job) => job === "Original Music Composer" || job === "Music" || job === "Composer",
  },
];

const yearOf = (date: string | null | undefined): number | undefined => {
  const year =
    date === null || date === undefined ? Number.NaN : Number.parseInt(date.slice(0, 4), 10);

  return Number.isFinite(year) ? year : undefined;
};

const text = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim() === "" ? undefined : value.trim();

const isoDate = (value: string | null | undefined): string | undefined =>
  value !== null && value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;

const positive = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined || value <= 0 ? undefined : value;

const score = (
  value: number | null | undefined,
  votes: number | null | undefined,
): Score | undefined => {
  const average = positive(value);

  return average === undefined
    ? undefined
    : { value: Math.round(average * 10) / 10, votes: votes ?? undefined };
};

const idsOf = (list: { readonly results: ReadonlyArray<{ readonly id: number }> } | undefined) =>
  (list?.results ?? []).map((result) => String(result.id));

const recommended = (
  recommendations: typeof IdList.Type | undefined,
  similar: typeof IdList.Type | undefined,
): ReadonlyArray<string> =>
  [...new Set([...idsOf(recommendations), ...idsOf(similar)])].slice(0, RECOMMENDATION_LIMIT);

const trailerOf = (videos: typeof Videos.Type | undefined) => {
  const youtube = (videos?.results ?? []).filter((video) => video.site === "YouTube");

  const chosen =
    youtube.find((video) => video.type === "Trailer" && video.official === true) ??
    youtube.find((video) => video.type === "Trailer") ??
    youtube.find((video) => video.type === "Teaser");

  return chosen === undefined || youtubeKeyOf(chosen.key) !== chosen.key
    ? undefined
    : { key: chosen.key, name: text(chosen.name) };
};

const numbered = (entries: ReadonlyArray<Omit<ProviderCredit, "order">>): Array<ProviderCredit> =>
  entries.map((entry, order) => ({
    personId: entry.personId,
    name: entry.name,
    kind: entry.kind,
    role: entry.role,
    order,
    profile: entry.profile,
  }));

const crewCredits = (
  crew: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly job: string | undefined;
    readonly department: string | undefined;
    readonly profile: string | undefined;
  }>,
): ReadonlyArray<Omit<ProviderCredit, "order">> =>
  CREW_JOBS.flatMap(({ kind, limit, matches }) => {
    const seen = new Set<number>();

    const fresh = (id: number): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);

      return true;
    };

    return crew
      .filter((member) => matches(member.job ?? "", member.department ?? "") && fresh(member.id))
      .slice(0, limit)
      .map((member) => ({
        personId: String(member.id),
        name: member.name,
        kind,
        role: kind === "writer" ? member.job : undefined,
        profile: member.profile,
      }));
  });

const usCertification = (
  results: ReadonlyArray<{
    readonly iso_3166_1: string;
    readonly certification?: string;
    readonly rating?: string;
  }>,
): string | undefined => {
  const us = results.find((result) => result.iso_3166_1 === "US");

  return text(us?.certification ?? us?.rating);
};

const make = Effect.fn("Tmdb.make")(function* (options: TmdbOptions) {
  const cache = yield* DiskCache.Service;
  const apiBase = new URL(options.apiBaseUrl);

  const manifest: PluginManifest = {
    id: PROVIDER,
    name: "The Movie Database",
    version: "1.0.0",
    role: "metadata",
    permissions: { hosts: [apiBase.host], paths: ["DATA_DIR/cache/tmdb"] },
  };

  const client = guardHosts(manifest, yield* HttpClient.HttpClient).pipe(
    HttpClient.withRateLimiter({
      limiter: yield* RateLimiter.RateLimiter,
      key: PROVIDER,
      limit: options.requestsPerSecond,
      window: "1 second",
      algorithm: "token-bucket",
      times: 3,
    }),
  );

  const image = (size: string, path: string | null | undefined): string | undefined =>
    path === null || path === undefined ? undefined : `${options.imageBaseUrl}/${size}${path}`;

  const request = <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    path: string,
    params: Readonly<Record<string, string>>,
    schema: S,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(options.apiKey)) {
        return yield* new MetadataProviderUnavailable({
          provider: PROVIDER,
          reason: "missing-credentials",
        });
      }

      const key = Redacted.value(options.apiKey.value);
      const query = new URLSearchParams({ ...params, language: options.language });
      query.sort();
      const cacheKey = `${path}?${query.toString()}`;

      const failed = (status: number | null, detail: string) =>
        new MetadataRequestFailed({ provider: PROVIDER, operation, status, detail });

      const cached = yield* cache.read(PROVIDER, cacheKey, options.cacheMaxAge);

      const body = Option.isSome(cached)
        ? cached.value
        : yield* Effect.gen(function* () {
            const isReadAccessToken = key.startsWith("eyJ");

            if (!isReadAccessToken) query.set("api_key", key);

            const outgoing = HttpClientRequest.get(
              `${options.apiBaseUrl}${path}?${query.toString()}`,
            ).pipe(
              HttpClientRequest.acceptJson,
              isReadAccessToken ? HttpClientRequest.bearerToken(key) : identity,
            );

            const response = yield* client.execute(outgoing).pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.timeout(options.timeout),
              Effect.catchTags({
                TimeoutError: () => Effect.fail(failed(null, "timed out")),
                HttpClientError: (error) =>
                  Effect.fail(
                    failed(
                      error.response?.status ?? null,
                      error.reason.description ?? "request failed",
                    ),
                  ),
                RateLimiterError: () => Effect.fail(failed(429, "rate limited")),
              }),
            );

            if (response.status < 200 || response.status >= 300) {
              return yield* failed(response.status, "unexpected status");
            }

            const fresh = yield* response.text.pipe(
              Effect.mapError((error) =>
                failed(response.status, error.reason.description ?? "unreadable body"),
              ),
            );

            yield* cache.write(PROVIDER, cacheKey, fresh);

            return fresh;
          }).pipe(
            Effect.timeoutOrElse({
              duration: options.requestTimeout,
              orElse: () => Effect.fail(failed(null, "timed out")),
            }),
          );

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.mapError((error) => failed(null, error.message)),
      );
    }).pipe(Effect.withSpan(`Tmdb.${operation}`, { attributes: { "tmdb.path": path } }));

  const search = Effect.fn("Tmdb.search")(function* (query: TitleQuery) {
    const year =
      query.year === undefined
        ? {}
        : { [query.kind === "movie" ? "year" : "first_air_date_year"]: String(query.year) };

    if (query.kind === "movie") {
      const found = yield* request(
        "searchMovie",
        "/search/movie",
        { query: query.title, include_adult: "false", ...year },
        SearchMovies,
      );

      return found.results.map((result): TitleMatch => ({
        kind: "movie",
        providerId: String(result.id),
        title: result.title,
        year: yearOf(result.release_date),
        overview: text(result.overview),
        poster: image("w342", result.poster_path),
      }));
    }

    const found = yield* request(
      "searchShow",
      "/search/tv",
      { query: query.title, include_adult: "false", ...year },
      SearchShows,
    );

    return found.results.map((result): TitleMatch => ({
      kind: "show",
      providerId: String(result.id),
      title: result.name,
      year: yearOf(result.first_air_date),
      overview: text(result.overview),
      poster: image("w342", result.poster_path),
    }));
  });

  const findByExternalId = Effect.fn("Tmdb.findByExternalId")(function* (
    kind: TitleKind,
    ids: ExternalIds,
  ) {
    const lookup =
      ids.imdb === undefined
        ? ids.tvdb === undefined
          ? undefined
          : { source: "tvdb_id", id: ids.tvdb }
        : { source: "imdb_id", id: ids.imdb };

    if (lookup === undefined) return undefined;

    const found = yield* request(
      "find",
      `/find/${encodeURIComponent(lookup.id)}`,
      { external_source: lookup.source },
      FindResults,
    );

    const match = kind === "movie" ? found.movie_results[0] : found.tv_results[0];

    return match === undefined ? undefined : String(match.id);
  });

  const titleDetails = Effect.fn("Tmdb.titleDetails")(function* (
    kind: TitleKind,
    providerId: string,
  ) {
    const id = encodeURIComponent(providerId);

    if (kind === "movie") {
      const movie = yield* request(
        "movieDetails",
        `/movie/${id}`,
        {
          append_to_response: "release_dates,credits,keywords,videos,recommendations,similar",
          include_video_language: VIDEO_LANGUAGES,
        },
        MovieDetails,
      );

      const cast = (movie.credits?.cast ?? [])
        .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .slice(0, CAST_LIMIT)
        .map((member): Omit<ProviderCredit, "order"> => ({
          personId: String(member.id),
          name: member.name,
          kind: "actor",
          role: text(member.character),
          profile: image("w185", member.profile_path),
        }));

      const crew = crewCredits(
        (movie.credits?.crew ?? []).map((member) => ({
          id: member.id,
          name: member.name,
          job: text(member.job),
          department: text(member.department),
          profile: image("w185", member.profile_path),
        })),
      );

      const collection = movie.belongs_to_collection;

      return {
        provider: PROVIDER,
        kind,
        providerId: String(movie.id),
        ids: { tmdb: String(movie.id), imdb: text(movie.imdb_id), tvdb: undefined },
        title: movie.title,
        originalTitle: text(movie.original_title),
        year: yearOf(movie.release_date),
        releaseDate: text(movie.release_date),
        plot: text(movie.overview),
        tagline: text(movie.tagline),
        runtimeMinutes: positive(movie.runtime),
        contentRating: usCertification(
          movie.release_dates?.results.flatMap((result) =>
            result.release_dates.map((date) => ({
              iso_3166_1: result.iso_3166_1,
              certification: date.certification,
            })),
          ) ?? [],
        ),
        rating: score(movie.vote_average, movie.vote_count),
        genres: (movie.genres ?? []).map((genre) => genre.name),
        studios: (movie.production_companies ?? []).map((company) => company.name),
        countries: (movie.production_countries ?? []).map((country) => country.name),
        tags: (movie.keywords?.keywords ?? []).map((keyword) => keyword.name).slice(0, TAG_LIMIT),
        originalLanguage: text(movie.original_language),
        status: undefined,
        trailer: trailerOf(movie.videos),
        collection:
          collection === null || collection === undefined
            ? undefined
            : {
                providerId: String(collection.id),
                name: collection.name,
                overview: undefined,
                images: {
                  poster: image("w500", collection.poster_path),
                  backdrop: image("w1280", collection.backdrop_path),
                  still: undefined,
                },
              },
        recommendations: recommended(movie.recommendations, movie.similar),
        credits: numbered([...cast, ...crew]),
        images: {
          poster: image("w500", movie.poster_path),
          backdrop: image("w1280", movie.backdrop_path),
          still: undefined,
        },
      } satisfies ProviderTitle;
    }

    const show = yield* request(
      "showDetails",
      `/tv/${id}`,
      {
        append_to_response:
          "external_ids,content_ratings,aggregate_credits,keywords,videos,recommendations,similar",
        include_video_language: VIDEO_LANGUAGES,
      },
      ShowDetails,
    );

    const tvdb = show.external_ids?.tvdb_id;

    const creators = (show.created_by ?? []).map((creator): Omit<ProviderCredit, "order"> => ({
      personId: String(creator.id),
      name: creator.name,
      kind: "creator",
      role: undefined,
      profile: image("w185", creator.profile_path),
    }));

    const regulars = (show.aggregate_credits?.cast ?? [])
      .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .slice(0, CAST_LIMIT)
      .map((member): Omit<ProviderCredit, "order"> => ({
        personId: String(member.id),
        name: member.name,
        kind: "actor",
        role: text(member.roles?.[0]?.character),
        profile: image("w185", member.profile_path),
      }));

    const showCrew = crewCredits(
      (show.aggregate_credits?.crew ?? [])
        .toSorted(
          (left, right) => (right.total_episode_count ?? 0) - (left.total_episode_count ?? 0),
        )
        .flatMap((member) =>
          (member.jobs ?? []).map((job) => ({
            id: member.id,
            name: member.name,
            job: text(job.job) === "Executive Producer" ? "Producer" : text(job.job),
            department: text(member.department),
            profile: image("w185", member.profile_path),
          })),
        ),
    ).filter((entry) => entry.kind === "producer" || entry.kind === "composer");

    return {
      provider: PROVIDER,
      kind,
      providerId: String(show.id),
      ids: {
        tmdb: String(show.id),
        imdb: text(show.external_ids?.imdb_id),
        tvdb: tvdb === null || tvdb === undefined ? undefined : String(tvdb),
      },
      title: show.name,
      originalTitle: text(show.original_name),
      year: yearOf(show.first_air_date),
      releaseDate: text(show.first_air_date),
      plot: text(show.overview),
      tagline: text(show.tagline),
      runtimeMinutes: positive(show.episode_run_time?.[0]),
      contentRating: usCertification(show.content_ratings?.results ?? []),
      rating: score(show.vote_average, show.vote_count),
      genres: (show.genres ?? []).map((genre) => genre.name),
      studios: (show.networks ?? []).map((network) => network.name),
      countries: (show.production_countries ?? []).map((country) => country.name),
      tags: (show.keywords?.results ?? []).map((keyword) => keyword.name).slice(0, TAG_LIMIT),
      originalLanguage: text(show.original_language),
      status: showStatusOf(text(show.status)),
      trailer: trailerOf(show.videos),
      collection: undefined,
      recommendations: recommended(show.recommendations, show.similar),
      credits: numbered([...regulars, ...creators, ...showCrew]),
      images: {
        poster: image("w500", show.poster_path),
        backdrop: image("w1280", show.backdrop_path),
        still: undefined,
      },
    } satisfies ProviderTitle;
  });

  const toEpisode = (episode: typeof EpisodeDetails.Type): ProviderEpisode => ({
    season: episode.season_number,
    episode: episode.episode_number,
    title: text(episode.name),
    plot: text(episode.overview),
    airDate: text(episode.air_date),
    runtimeMinutes: positive(episode.runtime),
    rating: score(episode.vote_average, episode.vote_count),
    ids: {
      tmdb: episode.id === undefined ? undefined : String(episode.id),
      imdb: undefined,
      tvdb: undefined,
    },
    credits: numbered([
      ...(episode.guest_stars ?? [])
        .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .slice(0, GUEST_LIMIT)
        .map((member): Omit<ProviderCredit, "order"> => ({
          personId: String(member.id),
          name: member.name,
          kind: "guest-star",
          role: text(member.character),
          profile: image("w185", member.profile_path),
        })),
      ...crewCredits(
        (episode.crew ?? []).map((member) => ({
          id: member.id,
          name: member.name,
          job: text(member.job),
          department: text(member.department),
          profile: image("w185", member.profile_path),
        })),
      ).filter((entry) => entry.kind === "director" || entry.kind === "writer"),
    ]),
    images: {
      poster: undefined,
      backdrop: undefined,
      still: image("w300", episode.still_path),
    } satisfies ProviderImages,
  });

  const seasonDetails = Effect.fn("Tmdb.seasonDetails")(function* (showId: string, season: number) {
    const found = yield* request(
      "seasonDetails",
      `/tv/${encodeURIComponent(showId)}/season/${season}`,
      {},
      SeasonDetails,
    );

    return {
      season: found.season_number,
      ids: {
        tmdb: found.id === undefined ? undefined : String(found.id),
        imdb: undefined,
        tvdb: undefined,
      },
      title: text(found.name),
      plot: text(found.overview),
      airDate: text(found.air_date),
      images: { poster: image("w500", found.poster_path), backdrop: undefined, still: undefined },
      episodes: found.episodes.map(toEpisode),
    } satisfies ProviderSeason;
  });

  const episodeDetails = Effect.fn("Tmdb.episodeDetails")(function* (
    showId: string,
    season: number,
    episode: number,
  ) {
    const found = yield* request(
      "episodeDetails",
      `/tv/${encodeURIComponent(showId)}/season/${season}/episode/${episode}`,
      {},
      EpisodeDetails,
    );

    return toEpisode(found);
  });

  const collectionDetails = Effect.fn("Tmdb.collectionDetails")(function* (collectionId: string) {
    const found = yield* request(
      "collectionDetails",
      `/collection/${encodeURIComponent(collectionId)}`,
      {},
      CollectionDetails,
    );

    return {
      providerId: String(found.id),
      name: found.name,
      overview: text(found.overview),
      images: {
        poster: image("w500", found.poster_path),
        backdrop: image("w1280", found.backdrop_path),
        still: undefined,
      },
    } satisfies ProviderCollection;
  });

  const personDetails = Effect.fn("Tmdb.personDetails")(function* (personId: string) {
    const found = yield* request(
      "personDetails",
      `/person/${encodeURIComponent(personId)}`,
      { append_to_response: "external_ids" },
      PersonDetails,
    );

    const tvdb = found.external_ids?.tvdb_id;

    return {
      providerId: String(found.id),
      ids: {
        tmdb: String(found.id),
        imdb: text(found.imdb_id),
        tvdb: tvdb === null || tvdb === undefined ? undefined : String(tvdb),
      },
      name: found.name,
      biography: text(found.biography),
      birthDate: isoDate(found.birthday),
      deathDate: isoDate(found.deathday),
      birthPlace: text(found.place_of_birth),
      knownFor: text(found.known_for_department),
      profile: image("h632", found.profile_path),
    } satisfies ProviderPerson;
  });

  return Service.of({
    manifest,
    availability: Effect.succeed(
      Option.isSome(options.apiKey)
        ? { _tag: "Available" as const }
        : { _tag: "Unavailable" as const, reason: "missing-credentials" as const },
    ),
    search,
    findByExternalId,
    titleDetails,
    seasonDetails,
    episodeDetails,
    collectionDetails,
    personDetails,
  });
});

/** The TMDB plugin with explicit options; tests point it at a local server. */
export const layerWithOptions = (
  options: TmdbOptions,
): Layer.Layer<Service, never, DiskCache.Service | HttpClient.HttpClient> =>
  Layer.effect(Service, make(options)).pipe(
    Layer.provide(RateLimiter.layer),
    Layer.provide(RateLimiter.layerStoreMemory),
  );

/** The TMDB plugin with the configured key (`TMDB_API_KEY`, the built-in key, or none with `TMDB=off`). */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | DiskCache.Service | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return layerWithOptions(defaultOptions(config.tmdbApiKey));
  }),
);
