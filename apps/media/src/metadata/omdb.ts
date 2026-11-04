import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as DiskCache from "../disk-cache.ts";
import * as MediaConfig from "../media-config.ts";
import type { SiteRatings } from "../library/nfo.ts";
import { guardHosts } from "./metadata-plugin.ts";

/** How the OMDb client reaches OMDb. */
export interface OmdbOptions {
  /** Absent turns every lookup into a miss. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /** `https://www.omdbapi.com` in production. */
  readonly apiBaseUrl: string;
  readonly cacheMaxAge: Duration.Duration;
  readonly timeout: Duration.Duration;
}

/** Production OMDb with a one-day cache. */
export const defaultOptions = (apiKey: Option.Option<Redacted.Redacted>): OmdbOptions => ({
  apiKey,
  apiBaseUrl: "https://www.omdbapi.com",
  cacheMaxAge: Duration.days(1),
  timeout: Duration.seconds(10),
});

/** Looks up scores by IMDb ID. */
export interface Interface {
  /** Whether a key is configured. */
  readonly available: boolean;
  /** The scores OMDb knows; empty when it knows none, has no key, or cannot be reached. */
  readonly ratings: (imdbId: string) => Effect.Effect<SiteRatings>;
}

/** The OMDb client. */
export class Service extends Context.Service<Service, Interface>()("@media/server/Omdb") {}

const NAMESPACE = "omdb";

const IMDB_ID = /^tt\d{7,}$/u;

const Answer = Schema.Struct({
  Response: Schema.String,
  imdbRating: Schema.optionalKey(Schema.String),
  imdbVotes: Schema.optionalKey(Schema.String),
  Metascore: Schema.optionalKey(Schema.String),
  Ratings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ Source: Schema.String, Value: Schema.String })),
  ),
});

const decodeAnswer = Schema.decodeEffect(Schema.fromJsonString(Answer));

const REFUSED_PAUSE = Duration.hours(1);

const REFUSALS: ReadonlySet<number> = new Set([401, 403, 429]);

class OmdbPaused extends Schema.TaggedError<OmdbPaused>()("OmdbPaused", {}) {}

class OmdbRequestFailed extends Schema.TaggedError<OmdbRequestFailed>()("OmdbRequestFailed", {
  status: Schema.Int,
}) {
  override get message(): string {
    return `OMDb answered ${String(this.status)}`;
  }
}

/** A number from OMDb's text, where `N/A` means unknown and votes carry thousands separators. */
const numberOf = (text: string | undefined): number | undefined => {
  const value = text === undefined ? Number.NaN : Number.parseFloat(text.replaceAll(",", ""));

  return Number.isFinite(value) ? value : undefined;
};

const between = (value: number | undefined, max: number): number | undefined =>
  value === undefined || value < 0 || value > max ? undefined : value;

const ratingsOfAnswer = (answer: typeof Answer.Type): SiteRatings => {
  if (answer.Response !== "True") return {};
  const imdb = between(numberOf(answer.imdbRating), 10);
  const votes = numberOf(answer.imdbVotes);

  const rottenTomatoes = between(
    numberOf(answer.Ratings?.find((rating) => rating.Source === "Rotten Tomatoes")?.Value),
    100,
  );

  const metacritic = between(numberOf(answer.Metascore), 100);

  return {
    imdb:
      imdb === undefined
        ? undefined
        : { value: imdb, votes: votes === undefined ? undefined : Math.round(votes) },
    rottenTomatoes: rottenTomatoes === undefined ? undefined : Math.round(rottenTomatoes),
    metacritic: metacritic === undefined ? undefined : Math.round(metacritic),
  };
};

const make = Effect.fn("Omdb.make")(function* (options: OmdbOptions) {
  const cache = yield* DiskCache.Service;
  const apiBase = new URL(options.apiBaseUrl);

  const client = guardHosts(
    {
      id: NAMESPACE,
      name: "OMDb",
      version: "1.0.0",
      role: "metadata",
      permissions: { hosts: [apiBase.host], paths: ["DATA_DIR/cache/omdb"] },
    },
    yield* HttpClient.HttpClient,
  );

  const pausedUntil = yield* Ref.make(0);

  const fetchBody = Effect.fn("Omdb.fetch")(function* (key: string, imdbId: string) {
    const cached = yield* cache.read(NAMESPACE, imdbId, options.cacheMaxAge);

    if (Option.isSome(cached)) return cached.value;
    const now = yield* Clock.currentTimeMillis;

    if (now < (yield* Ref.get(pausedUntil))) return yield* new OmdbPaused();
    const query = new URLSearchParams({ i: imdbId, apikey: key });

    const response = yield* client
      .execute(
        HttpClientRequest.get(`${options.apiBaseUrl}/?${query.toString()}`).pipe(
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        // The URL carries the key, so no client span records it.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.timeout(options.timeout),
      );

    if (response.status < 200 || response.status >= 300) {
      if (REFUSALS.has(response.status)) {
        yield* Ref.set(pausedUntil, now + Duration.toMillis(REFUSED_PAUSE));
      }

      return yield* new OmdbRequestFailed({ status: response.status });
    }

    const body = yield* response.text;

    yield* cache.write(NAMESPACE, imdbId, body);

    return body;
  });

  const ratings = (imdbId: string): Effect.Effect<SiteRatings> =>
    Option.match(options.apiKey, {
      onNone: () => Effect.succeed({}),
      onSome: (key) =>
        IMDB_ID.test(imdbId)
          ? fetchBody(Redacted.value(key), imdbId).pipe(
              Effect.flatMap(decodeAnswer),
              Effect.map(ratingsOfAnswer),
              Effect.catchTag("OmdbPaused", () => Effect.succeed({})),
              Effect.catch((error) =>
                Effect.logWarning("Omdb.lookup_failed", error.message).pipe(
                  Effect.annotateLogs({ imdbId }),
                  Effect.as({}),
                ),
              ),
              Effect.withSpan("Omdb.ratings", { attributes: { "omdb.imdb_id": imdbId } }),
            )
          : Effect.succeed({}),
    });

  return Service.of({ available: Option.isSome(options.apiKey), ratings });
});

/** The client with explicit options; tests point it at a local server. */
export const layerWithOptions = (
  options: OmdbOptions,
): Layer.Layer<Service, never, DiskCache.Service | HttpClient.HttpClient> =>
  Layer.effect(Service, make(options));

/** The client configured from `OMDB_API_KEY`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | DiskCache.Service | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return layerWithOptions(defaultOptions(config.omdbApiKey));
  }),
);
