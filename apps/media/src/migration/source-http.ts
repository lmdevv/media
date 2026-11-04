/**
 * The HTTP boundary both migration-source plugins share. It owns request construction, the
 * manifest guard, status classification, JSON decoding, timeouts, and transient retries (reads
 * only), and translates every failure into a `SourceError`.
 *
 * Effect's client spans record request headers, and `X-Plex-Token` is not a header Effect redacts,
 * so source requests run with client tracing disabled; each operation records its own span with
 * the request path only.
 */
import { Duration, Effect, Match, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import type { MigrationSource } from "@media/contracts/models/jobs";

import type { SourceError, SourceManifest } from "./source-plugin.ts";
import {
  guardSourceRequests,
  SourceAuthFailed,
  SourceNotAdmin,
  SourceUnexpectedResponse,
  SourceUnreachable,
} from "./source-plugin.ts";

const REQUEST_TIMEOUT = Duration.seconds(30);

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const isTransient: (error: SourceError) => boolean = Match.type<SourceError>().pipe(
  Match.tag("SourceUnreachable", () => true),
  Match.tag(
    "SourceUnexpectedResponse",
    (error) => error.status !== null && TRANSIENT_STATUSES.has(error.status),
  ),
  Match.orElse(() => false),
);

type QueryParams = Readonly<Record<string, string | number | boolean | undefined>>;

/** Typed reads (and the sign-in POST) against one source server. */
export interface SourceHttp {
  readonly get: <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    path: string,
    params: QueryParams,
    schema: S,
  ) => Effect.Effect<S["Type"], SourceError>;
  readonly post: <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    path: string,
    body: Schema.Json,
    schema: S,
  ) => Effect.Effect<S["Type"], SourceError>;
}

/** Where and how a plugin's requests go. */
export interface SourceHttpOptions {
  readonly source: MigrationSource;
  readonly manifest: SourceManifest;
  /** Base URL without a trailing slash; paths are appended to it. */
  readonly baseUrl: string;
  /** Headers every request carries, such as the auth header. Kept out of spans and errors. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Lowercases the first letter of every object key before decoding, for servers whose casing
   * changed between versions (Jellyfin answers PascalCase, and camelCase on some endpoints).
   */
  readonly camelCaseKeys: boolean;
}

/** `json` with the first letter of every object key lowercased, recursively. */
export const camelCaseKeys = (json: Schema.Json): Schema.Json => {
  if (Array.isArray(json)) return json.map(camelCaseKeys);

  if (
    json === null ||
    Predicate.isString(json) ||
    Predicate.isNumber(json) ||
    Predicate.isBoolean(json)
  ) {
    return json;
  }

  return Object.fromEntries(
    Object.entries(json).map(([key, value]) => [
      `${key.charAt(0).toLowerCase()}${key.slice(1)}`,
      camelCaseKeys(value),
    ]),
  );
};

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const queryString = (params: QueryParams): string => {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }

  const text = query.toString();

  return text === "" ? "" : `?${text}`;
};

/** Builds the boundary over the process's HTTP client. */
export const makeSourceHttp = Effect.fnUntraced(function* (options: SourceHttpOptions) {
  const base = yield* HttpClient.HttpClient;
  const client = guardSourceRequests(options.manifest, base);
  const { source } = options;

  const unexpected = (operation: string, status: number | null, detail: string) =>
    new SourceUnexpectedResponse({ source, operation, status, detail });

  const send = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    retry: boolean,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, SourceError> => {
    const attempt: Effect.Effect<HttpClientResponse.HttpClientResponse, SourceError> = client
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(new SourceUnreachable({ source, operation, detail: "timed out" })),
        }),
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(
              Predicate.isTagged(error.reason, "TransportError")
                ? new SourceUnreachable({ source, operation, detail: "no connection" })
                : unexpected(operation, error.response?.status ?? null, "request failed"),
            ),
        }),
        Effect.flatMap(
          (response): Effect.Effect<HttpClientResponse.HttpClientResponse, SourceError> => {
            if (response.status === 401) return Effect.fail(new SourceAuthFailed({ source }));

            if (response.status === 403) return Effect.fail(new SourceNotAdmin({ source }));

            return response.status >= 200 && response.status < 300
              ? Effect.succeed(response)
              : Effect.fail(unexpected(operation, response.status, "unexpected status"));
          },
        ),
      );

    return (
      retry
        ? attempt.pipe(
            Effect.retry({
              while: isTransient,
              schedule: Schedule.exponential("500 millis"),
              times: 2,
            }),
          )
        : attempt
    ).pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
  };

  const decode = <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ): Effect.Effect<S["Type"], SourceError> =>
    response.text.pipe(
      Effect.mapError(() => unexpected(operation, response.status, "unreadable body")),
      Effect.flatMap((text) =>
        decodeJsonText(text).pipe(
          Effect.map((json) => (options.camelCaseKeys ? camelCaseKeys(json) : json)),
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(() => unexpected(operation, response.status, "unexpected body")),
        ),
      ),
    );

  const get: SourceHttp["get"] = (operation, path, params, schema) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(`${options.baseUrl}${path}${queryString(params)}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(options.headers),
      );

      return yield* decode(operation, yield* send(operation, request, true), schema);
    }).pipe(
      Effect.withSpan(`MigrationSource.${operation}`, {
        attributes: { "migration.source": source, "migration.path": path },
      }),
    );

  const post: SourceHttp["post"] = (operation, path, body, schema) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`${options.baseUrl}${path}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(options.headers),
        HttpClientRequest.bodyJsonUnsafe(body),
      );

      return yield* decode(operation, yield* send(operation, request, false), schema);
    }).pipe(
      Effect.withSpan(`MigrationSource.${operation}`, {
        attributes: { "migration.source": source, "migration.path": path },
      }),
    );

  const http: SourceHttp = { get, post };

  return http;
});

/** Collects every page of a paged listing, `pageSize` items at a time. */
export const allPages = <Item, E>(
  pageSize: number,
  fetchPage: (
    start: number,
  ) => Effect.Effect<{ readonly items: ReadonlyArray<Item>; readonly total: number | null }, E>,
): Effect.Effect<ReadonlyArray<Item>, E> => {
  const step = (start: number, found: ReadonlyArray<Item>): Effect.Effect<ReadonlyArray<Item>, E> =>
    fetchPage(start).pipe(
      Effect.flatMap(({ items, total }) => {
        const all = [...found, ...items];
        const done = items.length < pageSize || (total !== null && all.length >= total);

        return done ? Effect.succeed(all) : step(start + items.length, all);
      }),
    );

  return step(0, []);
};
