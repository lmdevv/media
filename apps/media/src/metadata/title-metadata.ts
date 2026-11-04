import { Cache, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";

import type { Artwork } from "../library/artwork.ts";
import type { MediaName } from "../library/media-naming.ts";
import {
  ExternalIds,
  type LocalMetadata,
  type NfoActor,
  Score,
  ShowStatus,
  SiteRatings,
} from "../library/nfo.ts";
import * as MetadataPlugin from "./metadata-plugin.ts";
import {
  CreditKind,
  TitleKind,
  type ProviderCollection,
  type ProviderCredit,
  type ProviderEpisode,
  type ProviderTitle,
  type TitleMatch,
  type TitleQuery,
} from "./metadata-plugin.ts";
import * as Omdb from "./omdb.ts";

/** An image stored beside the media or hosted by a provider. */
export const ImageRef = Schema.TaggedUnion({
  /** Path relative to the library root. */
  Local: { path: Schema.String },
  Remote: { url: Schema.String },
});

/** An image stored beside the media or hosted by a provider. */
export type ImageRef = typeof ImageRef.Type;

const MetadataSource = Schema.Literals(["name", "nfo", "provider"]);

/** A credited person with what they did, merged from the NFO and the provider. */
export const MergedCredit = Schema.Struct({
  name: Schema.String,
  ids: ExternalIds,
  profile: Schema.optional(ImageRef),
  kind: CreditKind,
  role: Schema.optional(Schema.String),
  order: Schema.Int,
});

/** A merged credit. */
export interface MergedCredit extends Schema.Schema.Type<typeof MergedCredit> {}

/** The collection a title belongs to, from an NFO `<set>` or the provider. */
export const MergedCollection = Schema.Struct({
  /** `tmdb:<id>`, or `set:<name>` for an NFO set without a TMDB ID. */
  sourceKey: Schema.String,
  name: Schema.String,
  overview: Schema.optional(Schema.String),
  poster: Schema.optional(ImageRef),
  backdrop: Schema.optional(ImageRef),
});

/** The collection a title belongs to. */
export interface MergedCollection extends Schema.Schema.Type<typeof MergedCollection> {}

/** Merged movie or show metadata. */
export const TitleMetadata = Schema.Struct({
  kind: TitleKind,
  title: Schema.String,
  originalTitle: Schema.optional(Schema.String),
  sortTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  contentRating: Schema.optional(Schema.String),
  ratings: SiteRatings,
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  countries: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  originalLanguage: Schema.optional(Schema.String),
  status: Schema.optional(ShowStatus),
  /** A YouTube video ID. */
  trailer: Schema.optional(
    Schema.Struct({ key: Schema.String, name: Schema.optional(Schema.String) }),
  ),
  collection: Schema.optional(MergedCollection),
  /** Provider IDs of recommended titles. */
  recommendations: Schema.Array(Schema.String),
  credits: Schema.Array(MergedCredit),
  ids: ExternalIds,
  poster: Schema.optional(ImageRef),
  backdrop: Schema.optional(ImageRef),
  logo: Schema.optional(ImageRef),
  banner: Schema.optional(ImageRef),
  sources: Schema.Array(MetadataSource),
});

/** Merged movie or show metadata. */
export interface TitleMetadata extends Schema.Schema.Type<typeof TitleMetadata> {}

/** Merged episode metadata. For a multi-episode file, values describe the first episode. */
export const EpisodeMetadata = Schema.Struct({
  season: Schema.Int,
  episodes: Schema.NonEmptyArray(Schema.Int),
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  rating: Schema.optional(Score),
  ids: ExternalIds,
  seasonIds: ExternalIds,
  /** Guest stars and the episode's own directors and writers. */
  credits: Schema.Array(MergedCredit),
  still: Schema.optional(ImageRef),
  seasonPoster: Schema.optional(ImageRef),
  sources: Schema.Array(MetadataSource),
});

/** Merged episode metadata. */
export interface EpisodeMetadata extends Schema.Schema.Type<typeof EpisodeMetadata> {}

interface TitleInput {
  readonly kind: TitleKind;
  readonly title: string;
  readonly year: number | undefined;
  readonly nameIds: ExternalIds;
  readonly local: LocalMetadata | undefined;
  readonly artwork: Artwork;
  readonly actorImages: (name: string) => string | undefined;
}

interface EpisodeInput {
  readonly name: Extract<MediaName, { readonly _tag: "Episode" }>;
  readonly local: LocalMetadata | undefined;
  readonly still: string | undefined;
  readonly seasonPoster: string | undefined;
  readonly actorImages: (name: string) => string | undefined;
}

interface ResolvedTitle {
  readonly metadata: TitleMetadata;
  readonly providerId: string | undefined;
}

/** Resolves merged metadata. Never fails. */
export interface Interface {
  readonly title: (input: TitleInput) => Effect.Effect<ResolvedTitle>;
  readonly episode: (
    showProviderId: string | undefined,
    input: EpisodeInput,
  ) => Effect.Effect<EpisodeMetadata>;
}

/** The metadata resolver. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/MetadataResolver",
) {}

const normaliseTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");

/**
 * The search hit that confidently matches `query`: the same normalised title, and the same
 * year (or one year off, for regional release dates) when the query has a year.
 */
export const bestMatch = (
  query: TitleQuery,
  matches: ReadonlyArray<TitleMatch>,
): TitleMatch | undefined => {
  const wanted = normaliseTitle(query.title);
  const sameTitle = matches.filter((match) => normaliseTitle(match.title) === wanted);

  if (query.year === undefined) return sameTitle[0];
  const { year } = query;

  return (
    sameTitle.find((match) => match.year === year) ??
    sameTitle.find((match) => match.year !== undefined && Math.abs(match.year - year) === 1)
  );
};

const local = (path: string | undefined): ImageRef | undefined =>
  path === undefined ? undefined : ImageRef.cases.Local.make({ path });

const remote = (url: string | undefined): ImageRef | undefined =>
  url === undefined ? undefined : ImageRef.cases.Remote.make({ url });

const nonEmpty = <A>(
  primary: ReadonlyArray<A> | undefined,
  fallback: ReadonlyArray<A> | undefined,
): ReadonlyArray<A> => (primary !== undefined && primary.length > 0 ? primary : (fallback ?? []));

const sourcesOf = (nfo: boolean, provider: boolean): ReadonlyArray<typeof MetadataSource.Type> => [
  "name",
  ...(nfo ? (["nfo"] as const) : []),
  ...(provider ? (["provider"] as const) : []),
];

const normaliseName = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();

const PROVIDER_IMAGE_HOSTS: ReadonlySet<string> = new Set(["image.tmdb.org"]);

const providerImage = (url: string | undefined): ImageRef | undefined => {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);

  return parsed.protocol === "https:" && PROVIDER_IMAGE_HOSTS.has(parsed.host)
    ? remote(url)
    : undefined;
};

interface CreditSources {
  readonly actorImages: (name: string) => string | undefined;
  readonly provider: ReadonlyArray<ProviderCredit>;
}

const fromProvider = (
  sources: CreditSources,
  credit: ProviderCredit,
): Omit<MergedCredit, "order"> => ({
  name: credit.name,
  ids: { tmdb: credit.personId, imdb: undefined, tvdb: undefined },
  profile: local(sources.actorImages(credit.name)) ?? providerImage(credit.profile),
  kind: credit.kind,
  role: credit.role,
});

const fromNfo = (
  sources: CreditSources,
  kind: CreditKind,
  person: Pick<NfoActor, "name" | "role" | "thumb" | "ids">,
): Omit<MergedCredit, "order"> => {
  const wanted = normaliseName(person.name);
  const named = sources.provider.filter((credit) => normaliseName(credit.name) === wanted);
  const sameKind = named.find((credit) => credit.kind === kind);
  const anyKind = sameKind ?? named[0];

  return {
    name: person.name,
    ids: {
      tmdb: person.ids.tmdb ?? anyKind?.personId,
      imdb: person.ids.imdb,
      tvdb: person.ids.tvdb,
    },
    profile:
      local(sources.actorImages(person.name)) ??
      providerImage(person.thumb) ??
      providerImage(anyKind?.profile),
    kind,
    role: person.role ?? sameKind?.role,
  };
};

const byName = (name: string) => ({ name, role: undefined, thumb: undefined, ids: {} });

/**
 * Cast and crew: NFO actors, directors, and writers win over the provider's whenever the NFO
 * lists any of that kind; the provider fills the kinds an NFO cannot state (creators, producers,
 * composers). NFO actors are `castKind` (guest stars, for an episode).
 */
export const mergeCredits = (
  nfo: Pick<LocalMetadata, "actors" | "directors" | "writers"> | undefined,
  provider: ReadonlyArray<ProviderCredit>,
  actorImages: (name: string) => string | undefined,
  castKind: "actor" | "guest-star",
): ReadonlyArray<MergedCredit> => {
  const sources: CreditSources = { actorImages, provider };
  const providerOf = (kind: CreditKind) => provider.filter((credit) => credit.kind === kind);

  const kinds = (
    kind: CreditKind,
    listed: ReadonlyArray<Omit<MergedCredit, "order">>,
  ): ReadonlyArray<Omit<MergedCredit, "order">> =>
    listed.length > 0 ? listed : providerOf(kind).map((credit) => fromProvider(sources, credit));

  const merged = [
    ...kinds(
      castKind,
      (nfo?.actors ?? []).map((actor) => fromNfo(sources, castKind, actor)),
    ),
    ...providerOf("creator").map((credit) => fromProvider(sources, credit)),
    ...kinds(
      "director",
      (nfo?.directors ?? []).map((name) => fromNfo(sources, "director", byName(name))),
    ),
    ...kinds(
      "writer",
      (nfo?.writers ?? []).map((name) => fromNfo(sources, "writer", byName(name))),
    ),
    ...providerOf("producer").map((credit) => fromProvider(sources, credit)),
    ...providerOf("composer").map((credit) => fromProvider(sources, credit)),
  ];

  return merged.map((credit, order) => ({
    name: credit.name,
    ids: credit.ids,
    profile: credit.profile,
    kind: credit.kind,
    role: credit.role,
    order,
  }));
};

const nfoCollection = (
  nfo: NonNullable<LocalMetadata["collection"]>,
  provider: ProviderCollection | undefined,
): MergedCollection => {
  const same = provider !== undefined && provider.providerId === nfo.tmdb ? provider : undefined;

  return {
    sourceKey: nfo.tmdb === undefined ? `set:${normaliseName(nfo.name)}` : `tmdb:${nfo.tmdb}`,
    name: nfo.name,
    overview: nfo.overview ?? same?.overview,
    poster: providerImage(same?.images.poster),
    backdrop: providerImage(same?.images.backdrop),
  };
};

/** The NFO `<set>` wins; otherwise the provider's collection. */
export const mergeCollection = (
  nfo: LocalMetadata["collection"],
  provider: ProviderCollection | undefined,
): MergedCollection | undefined =>
  nfo === undefined
    ? provider === undefined
      ? undefined
      : {
          sourceKey: `tmdb:${provider.providerId}`,
          name: provider.name,
          overview: provider.overview,
          poster: providerImage(provider.images.poster),
          backdrop: providerImage(provider.images.backdrop),
        }
    : nfoCollection(nfo, provider);

/**
 * Scores by site: the NFO's win, then OMDb's (IMDb, Rotten Tomatoes, Metacritic), then the
 * provider's own. A bare `<rating>` counts as TMDB's when the NFO has no `<ratings>`.
 */
export const mergeRatings = (
  nfo: LocalMetadata | undefined,
  omdb: SiteRatings,
  provider: Score | undefined,
): SiteRatings => {
  const hasSiteRatings = Object.values(nfo?.ratings ?? {}).some((value) => value !== undefined);
  const bare = nfo?.rating !== undefined && !hasSiteRatings ? { value: nfo.rating } : undefined;

  return {
    tmdb: nfo?.ratings.tmdb ?? bare ?? provider,
    imdb: nfo?.ratings.imdb ?? omdb.imdb,
    rottenTomatoes: nfo?.ratings.rottenTomatoes ?? omdb.rottenTomatoes,
    metacritic: nfo?.ratings.metacritic ?? omdb.metacritic,
  };
};

const mergeTitle = (
  input: TitleInput,
  provider: ProviderTitle | undefined,
  omdb: SiteRatings,
  collection: ProviderCollection | undefined,
): TitleMetadata => {
  const nfo = input.local;
  const trailer = nfo?.trailer === undefined ? provider?.trailer : { key: nfo.trailer };

  return {
    kind: input.kind,
    title: nfo?.title ?? provider?.title ?? input.title,
    originalTitle: nfo?.originalTitle ?? provider?.originalTitle,
    sortTitle: nfo?.sortTitle,
    year: nfo?.year ?? provider?.year ?? input.year,
    releaseDate: nfo?.releaseDate ?? provider?.releaseDate,
    plot: nfo?.plot ?? provider?.plot,
    tagline: nfo?.tagline ?? provider?.tagline,
    runtimeMinutes: nfo?.runtimeMinutes ?? provider?.runtimeMinutes,
    contentRating: nfo?.contentRating ?? provider?.contentRating,
    ratings: mergeRatings(nfo, omdb, provider?.rating),
    genres: nonEmpty(nfo?.genres, provider?.genres),
    studios: nonEmpty(nfo?.studios, provider?.studios),
    countries: nonEmpty(nfo?.countries, provider?.countries),
    tags: nonEmpty(nfo?.tags, provider?.tags),
    originalLanguage: provider?.originalLanguage,
    status: nfo?.status ?? provider?.status,
    trailer,
    collection: mergeCollection(nfo?.collection, collection ?? provider?.collection),
    recommendations: provider?.recommendations ?? [],
    credits: mergeCredits(nfo, provider?.credits ?? [], input.actorImages, "actor"),
    ids: {
      tmdb: nfo?.ids.tmdb ?? input.nameIds.tmdb ?? provider?.ids.tmdb,
      imdb: nfo?.ids.imdb ?? input.nameIds.imdb ?? provider?.ids.imdb,
      tvdb: nfo?.ids.tvdb ?? input.nameIds.tvdb ?? provider?.ids.tvdb,
    },
    poster: local(input.artwork.poster) ?? remote(provider?.images.poster),
    backdrop: local(input.artwork.backdrop) ?? remote(provider?.images.backdrop),
    logo: local(input.artwork.logo),
    banner: local(input.artwork.banner),
    sources: sourcesOf(nfo !== undefined, provider !== undefined),
  };
};

const mergeEpisode = (
  input: EpisodeInput,
  provider: ProviderEpisode | undefined,
  season: { readonly poster: string | undefined; readonly ids: ExternalIds },
): EpisodeMetadata => ({
  season: input.name.season,
  episodes: input.name.episodes,
  title: input.local?.title ?? provider?.title ?? input.name.episodeTitle,
  plot: input.local?.plot ?? provider?.plot,
  airDate: input.local?.releaseDate ?? provider?.airDate,
  runtimeMinutes: input.local?.runtimeMinutes ?? provider?.runtimeMinutes,
  rating:
    input.local?.ratings.tmdb ??
    input.local?.ratings.imdb ??
    (input.local?.rating === undefined ? undefined : { value: input.local.rating }) ??
    provider?.rating,
  ids: {
    tmdb: input.local?.ids.tmdb ?? provider?.ids.tmdb,
    imdb: input.local?.ids.imdb ?? provider?.ids.imdb,
    tvdb: input.local?.ids.tvdb ?? provider?.ids.tvdb,
  },
  seasonIds: season.ids,
  credits: mergeCredits(input.local, provider?.credits ?? [], input.actorImages, "guest-star"),
  still: local(input.still) ?? remote(provider?.images.still),
  seasonPoster: local(input.seasonPoster) ?? remote(season.poster),
  sources: sourcesOf(input.local !== undefined, provider !== undefined),
});

const LOOKUP_CACHE = { capacity: 4096, success: Duration.hours(1) };

const cacheSuccessesOnly = <A, E>(exit: Exit.Exit<Option.Option<A>, E>): Duration.Duration =>
  Exit.isSuccess(exit) && Option.isSome(exit.value) ? LOOKUP_CACHE.success : Duration.zero;

const make = Effect.gen(function* () {
  const plugin = yield* MetadataPlugin.Service;
  const omdb = yield* Omdb.Service;

  const logged =
    (operation: string) =>
    <A>(effect: Effect.Effect<A, MetadataPlugin.MetadataError>): Effect.Effect<Option.Option<A>> =>
      effect.pipe(
        Effect.asSome,
        Effect.catchTag("MetadataProviderUnavailable", () => Effect.succeedNone),
        Effect.catch((error) =>
          Effect.logWarning("MetadataResolver.provider_failed", error).pipe(
            Effect.annotateLogs({ operation, provider: plugin.manifest.id }),
            Effect.as(Option.none<A>()),
          ),
        ),
      );

  const providerTitle = Effect.fn("MetadataResolver.providerTitle")(function* (query: TitleQuery) {
    const providerId =
      query.ids.tmdb ??
      (yield* plugin.findByExternalId(query.kind, query.ids)) ??
      bestMatch(query, yield* plugin.search(query))?.providerId;

    return providerId === undefined
      ? undefined
      : yield* plugin.titleDetails(query.kind, providerId);
  });

  // Plain objects and arrays are compared structurally by `Equal`, so equal queries share one
  // lookup, including concurrent ones from episodes of the same show.
  const titles = yield* Cache.makeWith(
    (query: TitleQuery) => logged("title")(providerTitle(query)),
    {
      capacity: LOOKUP_CACHE.capacity,
      timeToLive: cacheSuccessesOnly,
    },
  );

  const seasons = yield* Cache.makeWith(
    ([showId, season]: readonly [string, number]) =>
      logged("season")(plugin.seasonDetails(showId, season)),
    { capacity: LOOKUP_CACHE.capacity, timeToLive: cacheSuccessesOnly },
  );

  const collections = yield* Cache.makeWith(
    (collectionId: string) => logged("collection")(plugin.collectionDetails(collectionId)),
    { capacity: LOOKUP_CACHE.capacity, timeToLive: cacheSuccessesOnly },
  );

  const title = Effect.fn("MetadataResolver.title")(function* (input: TitleInput) {
    const available = MetadataPlugin.PluginAvailability.guards.Available(
      yield* plugin.availability,
    );

    const ids = {
      tmdb: input.local?.ids.tmdb ?? input.nameIds.tmdb,
      imdb: input.local?.ids.imdb ?? input.nameIds.imdb,
      tvdb: input.local?.ids.tvdb ?? input.nameIds.tvdb,
    };

    const query: TitleQuery = {
      kind: input.kind,
      title: input.local?.title ?? input.title,
      year: input.local?.year ?? input.year,
      ids,
    };

    const provider = available ? Option.getOrUndefined(yield* Cache.get(titles, query)) : undefined;
    const collectionId = provider?.collection?.providerId;

    const collection =
      collectionId === undefined || input.local?.collection?.overview !== undefined
        ? undefined
        : Option.getOrUndefined(yield* Cache.get(collections, collectionId));

    const imdb = input.local?.ids.imdb ?? input.nameIds.imdb ?? provider?.ids.imdb;
    const scores = imdb === undefined ? {} : yield* omdb.ratings(imdb);

    return {
      metadata: mergeTitle(input, provider, scores, collection),
      providerId: provider?.providerId,
    } satisfies ResolvedTitle;
  });

  const episode = Effect.fn("MetadataResolver.episode")(function* (
    showProviderId: string | undefined,
    input: EpisodeInput,
  ) {
    const season =
      showProviderId === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* Cache.get(seasons, [showProviderId, input.name.season] as const),
          );

    const providerEpisode = season?.episodes.find(
      (candidate) => candidate.episode === input.name.episodes[0],
    );

    return mergeEpisode(input, providerEpisode, {
      poster: season?.images.poster,
      ids: season?.ids ?? {},
    });
  });

  return Service.of({ title, episode });
});

/** The resolver over the provided metadata plugin. */
export const layer: Layer.Layer<Service, never, MetadataPlugin.Service | Omdb.Service> =
  Layer.effect(Service, make);
