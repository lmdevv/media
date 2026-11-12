import { CommandFailure, RateLimited, commandError } from "@media/contracts/errors";
import type { CommandError, ErrorCode, RequestIdentity } from "@media/contracts/errors";
import { REQUEST_ID_HEADER, RequestId } from "@media/contracts/request-id";
import { PlaybackApiError } from "@media/contracts/media-playback";
import { Context, Effect, Option, Redacted, Schema, Stream } from "effect";

import type { CallError } from "./sdk-errors";
import { ProtocolError, TransportError } from "./sdk-errors";

/**
 * Where this client sends playback API requests, when not to the public URL a started session
 * names (`mediaBaseUrl`). A client that reaches the media service at an address its viewers
 * cannot, such as the CLI inside the server's container at `http://127.0.0.1:8080`, provides its
 * configured media URL here. The URLs the service answers with, such as `stream.url`, still use
 * the service's public URL, so they stay the ones to hand a player. None (the default) sends
 * requests to the session's URL.
 */
export const MediaOrigin = Context.Reference<Option.Option<string>>("@media/sdk/MediaOrigin", {
  defaultValue: Option.none,
});

/** Strips a trailing slash so routes join cleanly. */
export const baseUrl = (url: string): string => url.replace(/\/+$/u, "");

/** `path` on the media service of a started session, at `MediaOrigin` when one is provided. */
export const mediaUrl = (
  started: { readonly mediaBaseUrl: string },
  path: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const origin = Option.getOrElse(yield* MediaOrigin, () => started.mediaBaseUrl);

    return `${baseUrl(origin)}${path}`;
  });

/** `value` as the JSON its schema's JSON codec writes, for a request body. */
export const encodeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  value: A,
): Effect.Effect<Schema.Json> =>
  Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.orDie,
  );

/** One request to the media service. */
export interface MediaRequest {
  /** What the request does, for errors and traces, such as `playback.negotiate`. */
  readonly operation: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  /** The JSON body; none for requests without one. */
  readonly body: Option.Option<Schema.Json>;
  /** The caller's Convex auth token, sent as a bearer token. */
  readonly bearer: Option.Option<Redacted.Redacted>;
  /**
   * Whether the request must reach the media service even when the page that sends it is going
   * away, as a stream's stop must (`fetch`'s `keepalive`). Only small bodies may use it.
   */
  readonly keepalive?: boolean;
}

const TaggedFailure = Schema.Struct({ tag: Schema.String }).pipe(
  Schema.encodeKeys({ tag: "_tag" }),
);

const decodeCommandFailure = Schema.decodeUnknownOption(CommandFailure);

/** The `_tag` of a tagged value, such as an HttpApi failure body or an SDK error. */
export const decodeTagged = Schema.decodeUnknownOption(TaggedFailure);

const isSeconds = (seconds: number): boolean => Number.isInteger(seconds) && seconds >= 0;

const decodePlaybackFailure = Schema.decodeUnknownOption(Schema.toCodecJson(PlaybackApiError));

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const STATUS_CODES: ReadonlyMap<number, ErrorCode> = new Map([
  [400, "invalid_args"],
  [401, "unauthenticated"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [410, "expired"],
  [422, "invalid_args"],
  [429, "rate_limited"],
  [503, "rate_limited"],
  [507, "rate_limited"],
]);

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 504]);

const decodeRequestId = Schema.decodeUnknownOption(RequestId);

const identityOf = (response: Response): RequestIdentity => {
  const sent = response.headers.get(REQUEST_ID_HEADER) ?? "";

  return Option.match(
    Option.firstSomeOf(sent.split(",").map((part) => decodeRequestId(part.trim()))),
    { onNone: () => ({}), onSome: (requestId) => ({ requestId }) },
  );
};

interface Fetched {
  readonly response: Response;
  readonly identity: RequestIdentity;
}

/** A media service answer, its body read as JSON. */
export interface MediaResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: Schema.Json;
  /** The `Retry-After` seconds of a refused request. */
  readonly retryAfterSeconds: Option.Option<number>;
  readonly identity: RequestIdentity;
}

const readResponse = (
  request: MediaRequest,
  { response, identity }: Fetched,
): Effect.Effect<MediaResponse, TransportError | ProtocolError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new TransportError({
          operation: request.operation,
          message: `Transport failed during ${request.operation}: the response body was cut off`,
          cause,
          ...identity,
        }),
    });

    const body =
      text.length === 0
        ? null
        : yield* decodeJsonText(text).pipe(
            Effect.mapError(
              (cause) =>
                new ProtocolError({
                  operation: request.operation,
                  message: `Protocol error in ${request.operation}: the media service sent a body that is not JSON`,
                  cause,
                  ...identity,
                }),
            ),
          );

    const retryAfterSeconds = Option.fromNullishOr(response.headers.get("retry-after")).pipe(
      Option.map(Number),
      Option.filter(isSeconds),
    );

    return { status: response.status, ok: response.ok, body, identity, retryAfterSeconds };
  });

const fetchResponse = (
  request: MediaRequest,
  accept: string,
  fetchWith: typeof fetch = fetch,
): Effect.Effect<Fetched, TransportError> =>
  Effect.gen(function* () {
    const headers = new Headers({ accept });

    if (Option.isSome(request.body)) headers.set("content-type", "application/json");

    if (Option.isSome(request.bearer)) {
      headers.set("authorization", `Bearer ${Redacted.value(request.bearer.value)}`);
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchWith(request.url, {
          method: request.method,
          headers,
          signal,
          keepalive: request.keepalive ?? false,
          ...Option.match(request.body, {
            onNone: () => ({}),
            onSome: (body) => ({ body: JSON.stringify(body) }),
          }),
        }),
      catch: (cause) =>
        new TransportError({
          operation: request.operation,
          message: `Transport failed during ${request.operation}: the media service is unreachable`,
          cause,
        }),
    });

    const identity = identityOf(response);

    yield* Effect.logDebug("MediaHttp.response").pipe(
      Effect.annotateLogs({ operation: request.operation, status: response.status, ...identity }),
    );

    if (GATEWAY_STATUSES.has(response.status)) {
      return yield* new TransportError({
        operation: request.operation,
        message: `Transport failed during ${request.operation}: the media service is unreachable (HTTP ${String(response.status)})`,
        cause: null,
        ...identity,
      });
    }

    return { response, identity };
  });

/** Sends `request` with `fetchWith`, the global `fetch` by default, and reads its answer. */
export const send = (
  request: MediaRequest,
  fetchWith?: typeof fetch,
): Effect.Effect<MediaResponse, TransportError | ProtocolError> =>
  Effect.flatMap(fetchResponse(request, "application/json", fetchWith), (fetched) =>
    readResponse(request, fetched),
  );

const failureOf = (request: MediaRequest, response: MediaResponse): CommandError => {
  const known = decodeCommandFailure(response.body);

  if (Option.isSome(known)) return commandError(known.value, response.identity);

  const reason = Option.match(decodeTagged(response.body), {
    onNone: () => `HTTP ${String(response.status)}`,
    onSome: (tagged) => tagged.tag,
  });

  return commandError(
    {
      code: STATUS_CODES.get(response.status) ?? "internal",
      message: `The media service refused ${request.operation}: ${reason}`,
    },
    response.identity,
  );
};

/** The command error a refused `request` answered with, its `Retry-After` included. */
export const commandFailureOf = (request: MediaRequest, response: MediaResponse): CommandError => {
  const failure = failureOf(request, response);

  return failure instanceof RateLimited && Option.isSome(response.retryAfterSeconds)
    ? new RateLimited({
        message: failure.message,
        retryAfterSeconds: response.retryAfterSeconds.value,
        ...response.identity,
      })
    : failure;
};

const decodeSuccess = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
  response: MediaResponse,
): Effect.Effect<A, ProtocolError> =>
  Schema.decodeEffect(result)(response.body).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation: request.operation,
          message: `Protocol error in ${request.operation}: unexpected media service response`,
          cause,
          ...response.identity,
        }),
    ),
  );

/**
 * Sends a registry `media` command and decodes a successful body with `result`. Non-2xx answers
 * become command errors; network failures become `TransportError`; bodies that do not match
 * become `ProtocolError`.
 */
export const requestJson = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
): Effect.Effect<A, CallError> =>
  Effect.gen(function* () {
    const response = yield* send(request);

    if (!response.ok) return yield* commandFailureOf(request, response);

    return yield* decodeSuccess(request, result, response);
  }).pipe(Effect.withSpan("MediaHttp.request", { attributes: { operation: request.operation } }));

/** An answer streamed line by line: its headers, then its lines as they arrive. */
export interface LineResponse {
  readonly headers: Headers;
  /** The body's lines, without line ends; failing with `TransportError` if the body is cut off. */
  readonly lines: Stream.Stream<string, TransportError>;
}

/**
 * Sends a request whose answer is NDJSON, such as the retained log, and answers once its headers
 * arrive. Failures are registry command errors, as for `requestJson`. Ending or interrupting the
 * lines cancels the body, which closes the connection.
 */
export const requestLines = (request: MediaRequest): Effect.Effect<LineResponse, CallError> =>
  Effect.gen(function* () {
    const fetched = yield* fetchResponse(request, "application/x-ndjson");
    const { response } = fetched;

    if (!response.ok) {
      return yield* commandFailureOf(request, yield* readResponse(request, fetched));
    }

    const lines = Stream.fromReadableStream({
      evaluate: () => response.body ?? new ReadableStream<Uint8Array>(),
      onError: (cause) =>
        new TransportError({
          operation: request.operation,
          message: `Transport failed during ${request.operation}: the stream was cut off`,
          cause,
          ...fetched.identity,
        }),
    }).pipe(Stream.decodeText(), Stream.splitLines);

    const answer: LineResponse = { headers: response.headers, lines };

    return answer;
  }).pipe(Effect.withSpan("MediaHttp.lines", { attributes: { operation: request.operation } }));

/** Any failure of a playback API call. */
export type PlaybackCallError = PlaybackApiError | TransportError | ProtocolError;

/**
 * Sends a playback API request and decodes a successful body with `result`. Failures decode into
 * the playback API's tagged errors; a failure body outside that contract is a `ProtocolError`.
 */
export const requestPlayback = <A>(
  request: MediaRequest,
  result: Schema.Codec<A, unknown>,
): Effect.Effect<A, PlaybackCallError> =>
  Effect.gen(function* () {
    const response = yield* send(request);

    if (response.ok) return yield* decodeSuccess(request, Schema.toCodecJson(result), response);

    const failure = decodePlaybackFailure(response.body);

    if (Option.isSome(failure)) return yield* failure.value;

    return yield* new ProtocolError({
      operation: request.operation,
      message: `Protocol error in ${request.operation}: the media service failed with HTTP ${String(response.status)} and an unknown body`,
      cause: response.body,
      ...response.identity,
    });
  }).pipe(Effect.withSpan("MediaHttp.playback", { attributes: { operation: request.operation } }));
