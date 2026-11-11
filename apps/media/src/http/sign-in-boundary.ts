/**
 * The sign-in boundary (ADR 0007): every client signs in at `SIGN_IN_PATH`, which resolves the
 * client's address, takes a try from the `signIn` door of `@media/contracts/rate-limit` for it, and
 * relays the sign-in to the core's `auth:signIn` with a pass signed for that one sign-in. The core
 * refuses a sign-in without a good pass, so none skips the limit.
 *
 * The pass never leaves the server: the client gets back only what `auth:signIn` answered. The
 * body, which holds a password, a key, or a link code, is never logged.
 */
import { ErrorCode } from "@media/contracts/errors";
import {
  PASS_PARAM,
  SIGN_IN_BODY_MAX_BYTES,
  SIGN_IN_PATH,
  signInRefusalStatus,
  signInWaitingCodes,
} from "@media/contracts/sign-in";
import type { SignInProvider } from "@media/contracts/sign-in";
import { Clock, Duration, Effect, Layer, Match, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { clientAddress, makeDoors, retryAfter } from "./rate-limit.ts";
import { Passes, SignInBody } from "./sign-in-passes.ts";

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(SignInBody));

const Tokens = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

const Refusal = Schema.Struct({
  code: Schema.Union([ErrorCode, Schema.Literals(signInWaitingCodes)]),
  message: Schema.String,
});

/** What the core's HTTP API answers for `auth:signIn` (Convex's `POST /api/action`). */
const CoreAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("success"),
    value: Schema.Struct({ tokens: Schema.NullOr(Tokens) }),
  }),
  Schema.Struct({ status: Schema.Literal("error"), errorData: Schema.optionalKey(Refusal) }),
]);

type Answer =
  | { readonly kind: "signed"; readonly tokens: typeof Tokens.Type | null }
  | { readonly kind: "refused"; readonly refusal: typeof Refusal.Type }
  | { readonly kind: "failed" }
  | { readonly kind: "unreachable" };

const CORE_TIMEOUT = Duration.seconds(30);

const NO_STORE = { "cache-control": "no-store" };

const refusalResponse = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ code, message }, { status, headers: NO_STORE });

const relayTo = (client: HttpClient.HttpClient, coreUrl: string) => {
  const url = `${coreUrl.replace(/\/+$/u, "")}/api/action`;

  return Effect.fn("SignInBoundary.relay")(function* (signIn: {
    readonly provider: SignInProvider;
    readonly params: Readonly<Record<string, Schema.Json>>;
  }) {
    const answer = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ path: "auth:signIn", args: signIn, format: "json" }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CoreAnswer)),
        Effect.timeout(CORE_TIMEOUT),
        Effect.map((decoded): Answer =>
          decoded.status === "success"
            ? { kind: "signed", tokens: decoded.value.tokens }
            : decoded.errorData === undefined
              ? { kind: "failed" }
              : { kind: "refused", refusal: decoded.errorData },
        ),
        Effect.catchTags({
          HttpClientError: () => Effect.succeed<Answer>({ kind: "unreachable" }),
          TimeoutError: () => Effect.succeed<Answer>({ kind: "unreachable" }),
          SchemaError: () => Effect.succeed<Answer>({ kind: "failed" }),
        }),
      );

    return answer;
  });
};

/** Whether `headers` declare a body the route reads: a `Content-Length` within its limit. */
const fitsBody = (headers: Readonly<Record<string, string | undefined>>): boolean => {
  const length = headers["content-length"];
  const declared = Number(length);

  return (
    length !== undefined &&
    headers["transfer-encoding"] === undefined &&
    Number.isSafeInteger(declared) &&
    declared <= SIGN_IN_BODY_MAX_BYTES
  );
};

/** Where the core is, for the route's relay. */
export interface Options {
  readonly coreUrl: string;
}

/** Adds `POST SIGN_IN_PATH`, relaying sign-ins to the core at `options.coreUrl`. */
export const layer = (
  options: Options,
): Layer.Layer<never, never, HttpRouter.HttpRouter | HttpClient.HttpClient | Passes> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const passes = yield* Passes;
      const relay = relayTo(yield* HttpClient.HttpClient, options.coreUrl);
      const take = makeDoors();

      const signIn = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const address = clientAddress(request.remoteAddress, request.headers["x-forwarded-for"]);
        const admission = take("signIn", address, yield* Clock.currentTimeMillis);

        if (!admission.admitted) {
          yield* Effect.logDebug("SignInBoundary.limited");

          return retryAfter(
            refusalResponse(
              429,
              "rate_limited",
              `Too many sign-in attempts from this address; try again in ${String(admission.retryAfterSeconds)} seconds`,
            ),
            admission.retryAfterSeconds,
          );
        }

        if (!fitsBody(request.headers)) {
          return refusalResponse(
            400,
            "invalid_args",
            "Send a sign-in of at most 16 KiB with a Content-Length",
          );
        }

        const body = Option.flatMap(
          Option.getSuccess(yield* Effect.result(request.text)),
          decodeBody,
        );

        if (Option.isNone(body)) {
          return refusalResponse(400, "invalid_args", "Send a sign-in as { provider, params }");
        }

        const { provider, params } = body.value;
        const pass = yield* passes.pass(provider, params, address);
        const answer = yield* relay({ provider, params: { ...params, [PASS_PARAM]: pass } });

        yield* Effect.logInfo("SignInBoundary.relayed").pipe(
          Effect.annotateLogs({
            provider,
            outcome: answer.kind === "refused" ? answer.refusal.code : answer.kind,
          }),
        );

        return Match.value(answer).pipe(
          Match.discriminatorsExhaustive("kind")({
            signed: ({ tokens }) =>
              HttpServerResponse.jsonUnsafe({ tokens }, { headers: NO_STORE }),
            refused: ({ refusal }) =>
              refusalResponse(signInRefusalStatus[refusal.code], refusal.code, refusal.message),
            failed: () => refusalResponse(500, "internal", "The core failed while signing in"),
            unreachable: () =>
              refusalResponse(502, "internal", "The server could not reach the core"),
          }),
        );
      }).pipe(Effect.withSpan("SignInBoundary.signIn"));

      yield* router.add("POST", SIGN_IN_PATH, signIn);
    }),
  );
