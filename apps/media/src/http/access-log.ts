/**
 * The request log: one DEBUG record per response with its method, status, time taken, and path.
 * Effect's own request logger writes every response at INFO with the full path, so anyone who can
 * reach the port, with or without a token, could fill the retained log and rotate its history out.
 * At DEBUG nothing a caller sends is kept unless `LOG_LEVEL=debug` asks for it. The path loses its
 * query string, which carries playback tokens, and is cut to 128 characters. A handler that died
 * still logs at ERROR with its cause: that is a bug in the service, not traffic.
 */
import { REQUEST_ID_HEADER } from "@media/contracts/request-id";
import { Cause, Clock, Crypto, Effect, Exit } from "effect";
import {
  HttpEffect,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
  HttpServerResponse as Response,
} from "effect/http";

import { redactText } from "../observability.ts";

const MAX_PATH = 128;

const PLAIN_WORD = /^[A-Za-z0-9_-]{1,64}$/u;

const LOOKS_LIKE_SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const pathOf = (url: string): string => {
  const path = url.split(/[?#]/u, 1)[0] ?? "";

  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
};

const died = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && !Response.isHttpServerResponse(reason.defect),
  );

const clientRequestIdOf = (request: HttpServerRequest.HttpServerRequest) => {
  const sent = request.headers[REQUEST_ID_HEADER];

  return sent !== undefined &&
    PLAIN_WORD.test(sent) &&
    !LOOKS_LIKE_SERVER_ID.test(sent) &&
    redactText(sent) === sent
    ? { clientRequestId: sent }
    : {};
};

const logResponse = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(httpApp);

    const [response] = Exit.isSuccess(exit)
      ? [exit.value]
      : yield* HttpServerError.causeResponse(exit.cause);

    const annotations = {
      "http.method": request.method,
      "http.url": pathOf(request.url),
      "http.status": response.status,
      elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
    };

    yield* (
      Exit.isFailure(exit) && died(exit.cause)
        ? Effect.logError("HttpServer.handler_died", exit.cause)
        : Effect.logDebug("HttpServer.response")
    ).pipe(Effect.annotateLogs(annotations));

    return yield* exit;
  });

/** Logs each response `httpApp` sends and tags it with a request id; see the module comment. */
export const accessLog = <E, R>(
  httpApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  HttpServerRequest.HttpServerRequest | Crypto.Crypto | R
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const crypto = yield* Crypto.Crypto;

    // Effect's UUID generator reads bytes synchronously and never fails; its error type is the
    // interface's, shared with sources that can.
    const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);

    // The server sends the response, a failure's too, before this middleware sees the exit, so the
    // header goes on in a pre-response hook rather than on the returned response.
    return yield* logResponse(request, httpApp).pipe(
      HttpEffect.withPreResponseHandler((_, response) =>
        Effect.succeed(Response.setHeader(response, REQUEST_ID_HEADER, requestId)),
      ),
      Effect.annotateLogs({ requestId, ...clientRequestIdOf(request) }),
    );
  });
