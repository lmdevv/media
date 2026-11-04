import { Context, Effect, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";

import { ExternalIds, Score, ShowStatus } from "../library/nfo.ts";

const PluginPermissions = Schema.Struct({
  hosts: Schema.Array(Schema.String),
  paths: Schema.Array(Schema.String),
});

/** Identity, role, and permissions of a plugin. */
export const PluginManifest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  role: Schema.Literal("metadata"),
  permissions: PluginPermissions,
});

/** Identity, role, and permissions of a plugin. */
export interface PluginManifest extends Schema.Schema.Type<typeof PluginManifest> {}

/** Whether a plugin can serve requests right now. */
export const PluginAvailability = Schema.TaggedUnion({
  Available: {},
  Unavailable: { reason: Schema.Literals(["missing-credentials", "disabled"]) },
});

/** Whether a plugin can serve requests right now. */
export type PluginAvailability = typeof PluginAvailability.Type;

/** Movie or show. */
export const TitleKind = Schema.Literals(["movie", "show"]);

/** Movie or show. */
export type TitleKind = typeof TitleKind.Type;

/** A title to look up: from local IDs when known, otherwise by name and year. */
export const TitleQuery = Schema.Struct({
  kind: TitleKind,
  title: Schema.String,
  year: Schema.optional(Schema.Int),
  ids: ExternalIds,
});

/** A title to look up. */
export interface TitleQuery extends Schema.Schema.Type<typeof TitleQuery> {}

/** One search hit. */
export const TitleMatch = Schema.Struct({
  kind: TitleKind,
  /** The provider's own ID, such as a TMDB ID. */
  providerId: Schema.String,
  title: Schema.String,
  year: Schema.optional(Schema.Int),
  overview: Schema.optional(Schema.String),
  /** A small poster URL at the provider, for choosing between hits. */
  poster: Schema.optional(Schema.String),
});

/** One search hit. */
export interface TitleMatch extends Schema.Schema.Type<typeof TitleMatch> {}

/** Image URLs a provider knows for a title, season, or episode. */
export const ProviderImages = Schema.Struct({
  poster: Schema.optional(Schema.String),
  backdrop: Schema.optional(Schema.String),
  still: Schema.optional(Schema.String),
});

/** Image URLs a provider knows. */
export interface ProviderImages extends Schema.Schema.Type<typeof ProviderImages> {}

/** What a person did on a title or episode; `CreditKind` in contracts. */
export const CreditKind = Schema.Literals([
  "actor",
  "guest-star",
  "director",
  "writer",
  "creator",
  "producer",
  "composer",
]);

/** What a person did on a title or episode. */
export type CreditKind = typeof CreditKind.Type;

/** One credit as a provider lists it. */
export const ProviderCredit = Schema.Struct({
  /** The provider's own person ID. */
  personId: Schema.String,
  name: Schema.String,
  kind: CreditKind,
  role: Schema.optional(Schema.String),
  order: Schema.Int,
  /** A photo URL at the provider. */
  profile: Schema.optional(Schema.String),
});

/** One credit as a provider lists it. */
export interface ProviderCredit extends Schema.Schema.Type<typeof ProviderCredit> {}

/** The collection a movie belongs to at the provider. */
export const ProviderCollection = Schema.Struct({
  providerId: Schema.String,
  name: Schema.String,
  overview: Schema.optional(Schema.String),
  images: ProviderImages,
});

/** The collection a movie belongs to at the provider. */
export interface ProviderCollection extends Schema.Schema.Type<typeof ProviderCollection> {}

/** A person's details from a provider. */
export const ProviderPerson = Schema.Struct({
  providerId: Schema.String,
  ids: ExternalIds,
  name: Schema.String,
  biography: Schema.optional(Schema.String),
  birthDate: Schema.optional(Schema.String),
  deathDate: Schema.optional(Schema.String),
  birthPlace: Schema.optional(Schema.String),
  knownFor: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
});

/** A person's details from a provider. */
export interface ProviderPerson extends Schema.Schema.Type<typeof ProviderPerson> {}

/** Movie or show details from a provider. */
export const ProviderTitle = Schema.Struct({
  provider: Schema.String,
  kind: TitleKind,
  providerId: Schema.String,
  ids: ExternalIds,
  title: Schema.String,
  originalTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  contentRating: Schema.optional(Schema.String),
  /** The provider's own community score. */
  rating: Schema.optional(Score),
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  countries: Schema.Array(Schema.String),
  /** Keywords. */
  tags: Schema.Array(Schema.String),
  /** ISO 639-1. */
  originalLanguage: Schema.optional(Schema.String),
  status: Schema.optional(ShowStatus),
  /** A YouTube video ID of the official trailer. */
  trailer: Schema.optional(
    Schema.Struct({ key: Schema.String, name: Schema.optional(Schema.String) }),
  ),
  collection: Schema.optional(ProviderCollection),
  /** Provider IDs of recommended titles of the same kind, best first. */
  recommendations: Schema.Array(Schema.String),
  /** Top-billed cast, then key crew. */
  credits: Schema.Array(ProviderCredit),
  images: ProviderImages,
});

/** Movie or show details from a provider. */
export interface ProviderTitle extends Schema.Schema.Type<typeof ProviderTitle> {}

/** Episode details from a provider. */
export const ProviderEpisode = Schema.Struct({
  season: Schema.Int,
  episode: Schema.Int,
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  rating: Schema.optional(Score),
  ids: ExternalIds,
  /** Guest stars and the episode's own directors and writers. */
  credits: Schema.Array(ProviderCredit),
  images: ProviderImages,
});

/** Episode details from a provider. */
export interface ProviderEpisode extends Schema.Schema.Type<typeof ProviderEpisode> {}

/** Season details, with its episodes, from a provider. */
export const ProviderSeason = Schema.Struct({
  season: Schema.Int,
  ids: ExternalIds,
  title: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  airDate: Schema.optional(Schema.String),
  images: ProviderImages,
  episodes: Schema.Array(ProviderEpisode),
});

/** Season details from a provider. */
export interface ProviderSeason extends Schema.Schema.Type<typeof ProviderSeason> {}

/** The plugin cannot serve requests, for example because no API key is configured. */
export class MetadataProviderUnavailable extends Schema.TaggedError<MetadataProviderUnavailable>()(
  "MetadataProviderUnavailable",
  { provider: Schema.String, reason: Schema.Literals(["missing-credentials", "disabled"]) },
) {
  override get message(): string {
    return `Metadata provider unavailable: ${this.provider} (${this.reason})`;
  }
}

/** A provider request failed in transport, status, rate limiting, or decoding. */
export class MetadataRequestFailed extends Schema.TaggedError<MetadataRequestFailed>()(
  "MetadataRequestFailed",
  {
    provider: Schema.String,
    operation: Schema.String,
    /** HTTP status when the provider answered. */
    status: Schema.NullOr(Schema.Int),
    /** What went wrong, without the request URL (it may carry the API key). */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Metadata request failed: ${this.provider} ${this.operation} (status ${String(this.status)}): ${this.detail}`;
  }
}

/** A plugin tried to reach a host its manifest does not list. */
export class PluginPermissionDenied extends Schema.TaggedError<PluginPermissionDenied>()(
  "PluginPermissionDenied",
  { plugin: Schema.String, host: Schema.String },
) {
  override get message(): string {
    return `Plugin permission denied: ${this.plugin} may not reach ${this.host}`;
  }
}

/** Failures a metadata lookup can report. */
export type MetadataError =
  | MetadataProviderUnavailable
  | MetadataRequestFailed
  | PluginPermissionDenied;

/** A metadata provider. */
export interface Interface {
  readonly manifest: PluginManifest;
  readonly availability: Effect.Effect<PluginAvailability>;
  /** Titles matching a name and optional year, best match first. */
  readonly search: (query: TitleQuery) => Effect.Effect<ReadonlyArray<TitleMatch>, MetadataError>;
  /** Resolves external IDs (IMDb, TVDB) to the provider's own ID, when it knows the title. */
  readonly findByExternalId: (
    kind: TitleKind,
    ids: ExternalIds,
  ) => Effect.Effect<string | undefined, MetadataError>;
  readonly titleDetails: (
    kind: TitleKind,
    providerId: string,
  ) => Effect.Effect<ProviderTitle, MetadataError>;
  readonly seasonDetails: (
    showId: string,
    season: number,
  ) => Effect.Effect<ProviderSeason, MetadataError>;
  readonly episodeDetails: (
    showId: string,
    season: number,
    episode: number,
  ) => Effect.Effect<ProviderEpisode, MetadataError>;
  /** A collection's overview and artwork. */
  readonly collectionDetails: (
    collectionId: string,
  ) => Effect.Effect<ProviderCollection, MetadataError>;
  /** A person's biography, dates, and photo. */
  readonly personDetails: (personId: string) => Effect.Effect<ProviderPerson, MetadataError>;
}

/** The active metadata plugin. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/MetadataPlugin",
) {}

/**
 * Wraps `client` so every request to a host outside `manifest.permissions.hosts` fails with
 * `PluginPermissionDenied` before any bytes leave the process.
 */
export const guardHosts = (
  manifest: PluginManifest,
  client: HttpClient.HttpClient,
): HttpClient.HttpClient.With<HttpClientError.HttpClientError | PluginPermissionDenied> => {
  const allowed = new Set(manifest.permissions.hosts.map((host) => host.toLowerCase()));

  return HttpClient.mapRequestEffect(client, (request) => {
    const host = new URL(request.url).host.toLowerCase();

    return allowed.has(host)
      ? Effect.succeed(request)
      : Effect.fail(new PluginPermissionDenied({ plugin: manifest.id, host }));
  });
};
