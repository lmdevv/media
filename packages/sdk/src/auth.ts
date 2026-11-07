/**
 * Signing in and keeping the session's token fresh. Convex Auth issues a JWT that lasts an hour
 * and a refresh token that renews it. This service signs in with a password, an API key, or an
 * approved device code, stores the tokens through `TokenStorage`, hands the Convex connection a
 * token source that refreshes on demand, and signs out on the server and locally.
 *
 * Sign-in and refresh go through a private fetch-based client rather than the shared connection:
 * the WebSocket client waits for its token before running calls, so refreshing through it would
 * wait on itself.
 */
import type { FunctionPath } from "@media/contracts/command";
import { Unauthenticated } from "@media/contracts/errors";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Value } from "convex/values";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  FiberMap,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import * as ConvexTransport from "./convex-transport";
import type { CallError } from "./sdk-errors";
import { ProtocolError } from "./sdk-errors";
import * as TokenStorage from "./token-storage";
import type { StoredSession } from "./token-storage";

/** Whether the client holds a session. `loading` lasts until stored tokens have been read. */
export type AuthStatus = "loading" | "signedOut" | "signedIn";

/** What to sign in with. Each case is one Convex Auth provider. */
export type Credentials = Data.TaggedEnum<{
  /** Email and password. `signUp` creates the first account (the owner) or redeems an invite. */
  Password: {
    readonly flow: "signIn" | "signUp";
    readonly email: string;
    readonly password: Redacted.Redacted;
    readonly name: Option.Option<string>;
    readonly inviteCode: Option.Option<string>;
  };
  /** A scoped API key, as `media keys create` or Settings shows it once. */
  ApiKey: { readonly key: Redacted.Redacted };
  /** The secret device code of an approved device sign-in. */
  DeviceCode: { readonly deviceCode: Redacted.Redacted };
}>;

/** Constructors and matchers for `Credentials`. */
export const Credentials = Data.taggedEnum<Credentials>();

/** Email and password sign-in or sign-up as plain values, for the Promise and React entry points. */
export interface PasswordSignIn {
  readonly flow: "signIn" | "signUp";
  readonly email: string;
  readonly password: string;
  /** The new account's display name, for `signUp`. */
  readonly name?: string;
  /** The invite to redeem, for `signUp` after the owner exists. */
  readonly inviteCode?: string;
}

/** The `Password` credentials for `input`, with the password redacted. */
export const passwordCredentials = (input: PasswordSignIn): Credentials =>
  Credentials.Password({
    flow: input.flow,
    email: input.email,
    password: Redacted.make(input.password),
    name: Option.fromNullishOr(input.name),
    inviteCode: Option.fromNullishOr(input.inviteCode),
  });

/** A Convex Auth sign-in: a provider of the deployment and the params it takes. */
export interface SignInRequest {
  readonly provider: string;
  readonly params: Readonly<Record<string, Value>>;
}

/**
 * The provider has not signed anyone in yet: the core's device code provider answers `pending`
 * until the code is approved and `denied` once it is refused.
 */
export class SignInWaiting extends Schema.TaggedError<SignInWaiting>()("SignInWaiting", {
  state: Schema.Literals(["pending", "denied"]),
  message: Schema.String,
}) {}

const WaitingFailure = Schema.Struct({
  code: Schema.Literals(["pending", "denied"]),
  message: Schema.String,
});

const decodeWaiting = Schema.decodeUnknownOption(WaitingFailure);

/** Signs in and out and supplies the session's current token. */
export interface Interface {
  /** The current status, then every change. */
  readonly status: Stream.Stream<AuthStatus>;
  /** The status now, without waiting for a change. */
  readonly currentStatus: Effect.Effect<AuthStatus>;
  /**
   * Whether the connection runs signed out for now, because the server has failed to renew the
   * session for a while: now, then every change. The session stays signed in and stored, and is
   * renewed in the background; once a renewal succeeds the connection signs in again and this
   * turns false. False while signed out.
   */
  readonly reconnecting: Stream.Stream<boolean>;
  /** Whether the connection runs signed out for now, without waiting for a change. */
  readonly isReconnecting: Effect.Effect<boolean>;
  /**
   * Who is signed in now, as the account and session: renewing the session keeps it, signing in
   * as another account or session changes it. None while signed out.
   */
  readonly currentIdentity: Effect.Effect<Option.Option<string>>;
  /**
   * Signs in and stores the session. Rejected credentials fail with `Unauthenticated`; a sign-up
   * without a valid invite fails with `Forbidden` or `Conflict`.
   */
  readonly signIn: (
    credentials: Credentials,
  ) => Effect.Effect<void, CallError | TokenStorage.TokenStorageError>;
  /** Ends the session on the server when reachable, then forgets it locally. */
  readonly signOut: Effect.Effect<void, TokenStorage.TokenStorageError>;
  /**
   * The token for the next request, refreshed when it is about to expire or when `forceRefresh`
   * says the server rejected it. None when signed out, when the refresh token was refused, or
   * when this refresh finds the server has failed to renew the session for a while.
   */
  readonly accessToken: (
    forceRefresh: boolean,
  ) => Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError>;
}

/** The SDK's sign-in state. */
export class Auth extends Context.Service<Auth, Interface>()("@media/sdk/Auth") {}

const Tokens = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

/** `auth:signIn` answers with tokens, null tokens when it signed nobody in, or a redirect. */
const SignInResult = Schema.Struct({ tokens: Schema.optionalKey(Schema.NullOr(Tokens)) });

/**
 * A refresh answers with tokens, or null tokens when the server no longer knows the session.
 * Anything else, a redirect included, is a server fault rather than a refusal.
 */
const RefreshResult = Schema.Struct({ tokens: Schema.NullOr(Tokens) });

const ExpiryClaims = Schema.Struct({ exp: Schema.Finite });

const decodeExpiry = Schema.decodeUnknownOption(Schema.fromJsonString(ExpiryClaims));

const EXPIRY_MARGIN_MS = 60_000;

const tokenExpiry = (token: string): Option.Option<number> =>
  Option.map(
    Option.flatMap(TokenStorage.tokenPayload(token), decodeExpiry),
    (claims) => claims.exp * 1000,
  );

const { sessionOf } = TokenStorage;

const isSameSession = (a: StoredSession, b: StoredSession): boolean => {
  const held = sessionOf(a);

  return Option.isSome(held) && Option.contains(sessionOf(b), held.value);
};

const isExpiring = (token: string, now: number): boolean =>
  Option.match(tokenExpiry(token), {
    onNone: () => false,
    onSome: (expiresAt) => expiresAt - EXPIRY_MARGIN_MS <= now,
  });

const toSession = (tokens: typeof Tokens.Type): StoredSession => ({
  token: Redacted.make(tokens.token),
  refreshToken: Redacted.make(tokens.refreshToken),
});

const providerParams = (credentials: Credentials): SignInRequest =>
  Credentials.$match(credentials, {
    Password: ({ flow, email, password, name, inviteCode }) => ({
      provider: "password",
      params: {
        flow,
        email,
        password: Redacted.value(password),
        ...Option.match(name, { onNone: () => ({}), onSome: (value) => ({ name: value }) }),
        ...Option.match(inviteCode, {
          onNone: () => ({}),
          onSome: (value) => ({ inviteCode: value }),
        }),
      },
    }),
    ApiKey: ({ key }) => ({ provider: "apikey", params: { key: Redacted.value(key) } }),
    DeviceCode: ({ deviceCode }) => ({
      provider: "device",
      params: { deviceCode: Redacted.value(deviceCode) },
    }),
  });

const SIGN_IN: FunctionPath = "auth:signIn";

const SIGN_OUT: FunctionPath = "auth:signOut";

/** Options for the auth layer. */
export interface Options {
  /** The Convex deployment URL, the same one the connection uses. */
  readonly convexUrl: string;
  /**
   * How long the server may keep failing to renew a session, every refresh in between failing,
   * before the connection runs signed out while Auth keeps renewing; one minute when absent.
   */
  readonly refreshFailureLimit?: Duration.Duration;
  /**
   * The deployment's mutation that ends a session from any of its refresh tokens, as the core's
   * `core.auth.sessions.revoke` does. Without it, a sign-out calls `auth:signOut` with the
   * session's token.
   */
  readonly revoke?: FunctionPath;
}

type RefreshOutcome = Data.TaggedEnum<{
  Renewed: { readonly session: StoredSession };
  Refused: {};
  Kept: {};
  /** The server has failed every refresh for a while; its refresh token may still be good. */
  Stalled: {};
}>;

const RefreshOutcome = Data.taggedEnum<RefreshOutcome>();

const refused = (): Effect.Effect<RefreshOutcome> => Effect.succeed(RefreshOutcome.Refused());

const kept = (): Effect.Effect<RefreshOutcome> => Effect.succeed(RefreshOutcome.Kept());

const REFRESH_TIMEOUT = Duration.seconds(30);

/**
 * A connection waiting to reauthenticate stops, public queries included, until it gets a new
 * token or none, so a refresh the server keeps failing must hand it none for a while. A minute
 * outlasts a deploy or a burst of server errors.
 */
const DEFAULT_REFRESH_FAILURE_LIMIT = Duration.minutes(1);

const REFRESH_FAILURES_BEFORE_RECONNECTING = 3;

/**
 * Well past the longest the token fetcher waits between refreshes (30 seconds) plus a refresh's
 * own timeout. A longer gap between failures means nothing was retrying, as when the device
 * slept, so it starts a new run of failures rather than counting as time spent failing.
 */
const RETRY_GAP_LIMIT = Duration.minutes(2);

const renewalSchedule = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]);

const SERVER_SIGN_OUT_TIMEOUT = Duration.seconds(10);

/** A sign-out refused with one of these found nothing to end: the server no longer knows it. */
const SESSION_GONE = ["Unauthenticated", "Forbidden", "Expired"] as const;

const logStorageFailure = (error: TokenStorage.TokenStorageError): Effect.Effect<void> =>
  Effect.logWarning("Auth.tokenStorageFailed").pipe(
    Effect.annotateLogs({ operation: error.operation, message: error.message }),
  );

/**
 * The session lifecycle of any Convex Auth v1 deployment: `Auth` with the provider left open, so
 * the movies backend and the platform share one implementation of refresh, stalls, and sign-out.
 */
export interface Engine extends Omit<Interface, "signIn"> {
  /**
   * Signs in with `request` and stores the session; the session it stored, as its token's
   * subject. A provider that refuses fails with its refusal, such as `Unauthenticated`; one that
   * has not decided yet fails with `SignInWaiting`.
   */
  readonly open: (
    request: SignInRequest,
  ) => Effect.Effect<
    Option.Option<string>,
    CallError | SignInWaiting | TokenStorage.TokenStorageError
  >;
  /**
   * Signs out as `signOut` does, but only while the client's session is `session`, named by its
   * token's subject; whether it did. Another session the store moved the client to stays.
   */
  readonly signOutSession: (
    session: string,
  ) => Effect.Effect<boolean, TokenStorage.TokenStorageError>;
}

/**
 * Builds the session engine: reads the stored session, then gives the Convex connection a token
 * source. Requires the connection and a token store.
 */
export const makeEngine = Effect.fn("Auth.makeEngine")(function* (options: Options) {
  const transport = yield* ConvexTransport.ConvexTransport;
  const storage = yield* TokenStorage.TokenStorage;
  const context = yield* Effect.context();
  const scope = yield* Effect.scope;
  const gateway = new ConvexHttpClient(options.convexUrl, { logger: false });
  const status = yield* SubscriptionRef.make<AuthStatus>("loading");
  const session = yield* Ref.make(Option.none<StoredSession>());

  /**
   * What this client last read from or wrote to the store. The store differs from it only after
   * another writer, such as another tab, and differs from `session` after a write here failed.
   */
  const lastStored = yield* Ref.make(Option.none<StoredSession>());
  const refreshing = yield* Semaphore.make(1);

  const lastAttempt = yield* Ref.make<{
    readonly finished: number;
    readonly session: Option.Option<StoredSession>;
    readonly forced: boolean;
  }>({ finished: 0, session: Option.none(), forced: false });

  const committing = yield* Semaphore.make(1);

  const refreshFailureLimit = options.refreshFailureLimit ?? DEFAULT_REFRESH_FAILURE_LIMIT;

  const failing = yield* Ref.make(
    Option.none<{
      readonly session: StoredSession;
      readonly failures: number;
      readonly failingMillis: number;
      readonly lastNanos: bigint;
    }>(),
  );

  const reconnecting = yield* SubscriptionRef.make(false);
  const renewal = yield* FiberHandle.make<void>();
  const ending = yield* FiberMap.make<string>();

  const callGateway = Effect.fn("Auth.callGateway")(function* (
    path: FunctionPath,
    args: Readonly<Record<string, Value>>,
    token: Option.Option<Redacted.Redacted>,
    kind: "action" | "mutation" = "action",
  ) {
    return yield* Effect.tryPromise({
      try: () => {
        if (Option.isSome(token)) gateway.setAuth(Redacted.value(token.value));
        else gateway.clearAuth();

        return kind === "action"
          ? gateway.action(makeFunctionReference<"action", typeof args, Schema.Json>(path), args)
          : gateway.mutation(
              makeFunctionReference<"mutation", typeof args, Schema.Json>(path),
              args,
            );
      },
      catch: (cause) =>
        Option.match(cause instanceof ConvexError ? decodeWaiting(cause.data) : Option.none(), {
          onNone: () => ConvexTransport.translateFailure(path, cause),
          onSome: ({ code, message }) => new SignInWaiting({ state: code, message }),
        }),
    });
  });

  const requestTokens = Effect.fn("Auth.requestTokens")(function* (
    args: Readonly<Record<string, Value>>,
    answer: typeof SignInResult | typeof RefreshResult,
  ) {
    const raw = yield* callGateway(SIGN_IN, args, Option.none());

    const result = yield* Schema.decodeUnknownEffect(answer)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ProtocolError({
            operation: SIGN_IN,
            message: "Protocol error in auth:signIn: unexpected sign-in response",
            cause,
          }),
      ),
    );

    return Option.map(Option.fromNullishOr(result.tokens), toSession);
  });

  const currentToken = Effect.map(
    Ref.get(session),
    Option.map((current) => current.token),
  );

  const orTokenInMemory = (
    token: Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError>,
  ): Effect.Effect<Option.Option<Redacted.Redacted>> =>
    token.pipe(
      Effect.catchTag("TokenStorageError", (error) =>
        logStorageFailure(error).pipe(Effect.andThen(currentToken), Effect.flatMap(unlessRevoked)),
      ),
    );

  const tokenSource: ConvexTransport.AuthTokenSource = (forceRefresh) =>
    Effect.runPromiseWith(context)(
      accessToken(forceRefresh).pipe(
        orTokenInMemory,
        Effect.map(Option.match({ onNone: () => null, onSome: Redacted.value })),
      ),
    );

  const adopt = Effect.fn("Auth.adopt")(function* (next: Option.Option<StoredSession>) {
    yield* Ref.set(session, next);
    yield* Ref.set(failing, Option.none());
    yield* transport.setAuth(Option.isSome(next) ? tokenSource : null);
    yield* SubscriptionRef.set(status, Option.isSome(next) ? "signedIn" : "signedOut");
    yield* SubscriptionRef.set(reconnecting, false);
  });

  /**
   * Keeps `seen` after the server failed to renew it, until it has failed
   * `REFRESH_FAILURES_BEFORE_RECONNECTING` refreshes in a row over `refreshFailureLimit` of
   * retrying. A refresh that could not reach the server, or was told to wait, ends the run: the
   * server may be back, and nothing else worked before then.
   */
  const failed =
    (seen: StoredSession) =>
    (error: CallError | SignInWaiting): Effect.Effect<RefreshOutcome> =>
      Effect.gen(function* () {
        const now = yield* Clock.monotonicTimeNanos;

        const run = yield* Ref.modify(failing, (previous) => {
          const next = Option.match(
            Option.filter(
              previous,
              (last) =>
                last.session === seen &&
                Number(now - last.lastNanos) / 1e6 <= Duration.toMillis(RETRY_GAP_LIMIT),
            ),
            {
              onNone: () => ({ session: seen, failures: 1, failingMillis: 0, lastNanos: now }),
              onSome: (last) => ({
                session: seen,
                failures: last.failures + 1,
                failingMillis: last.failingMillis + Number(now - last.lastNanos) / 1e6,
                lastNanos: now,
              }),
            },
          );

          return [next, Option.some(next)] as const;
        });

        if (
          run.failures < REFRESH_FAILURES_BEFORE_RECONNECTING ||
          run.failingMillis < Duration.toMillis(refreshFailureLimit)
        ) {
          return yield* kept();
        }

        if (!(yield* SubscriptionRef.get(reconnecting))) {
          yield* Effect.logWarning("Auth.refreshStalled").pipe(
            Effect.annotateLogs({
              failures: run.failures,
              failingForMillis: Math.round(run.failingMillis),
              reason: error.message,
            }),
          );
        }

        return RefreshOutcome.Stalled();
      });

  const unreached = (): Effect.Effect<RefreshOutcome> =>
    Ref.set(failing, Option.none()).pipe(Effect.andThen(kept()));

  const requestRefresh = (seen: StoredSession): Effect.Effect<RefreshOutcome> =>
    requestTokens({ refreshToken: Redacted.value(seen.refreshToken) }, RefreshResult).pipe(
      Effect.map(
        Option.match({
          onNone: () => RefreshOutcome.Refused(),
          onSome: (renewed) => RefreshOutcome.Renewed({ session: renewed }),
        }),
      ),
      Effect.tap(() => Ref.set(failing, Option.none())),
      Effect.timeoutOption(REFRESH_TIMEOUT),
      Effect.flatMap(Option.match({ onNone: unreached, onSome: Effect.succeed })),
      Effect.catchTags({
        Unauthenticated: refused,
        Forbidden: refused,
        Expired: refused,
        TransportError: unreached,
        RateLimited: unreached,
        NotFound: failed(seen),
        InvalidArgs: failed(seen),
        Conflict: failed(seen),
        StaleRevision: failed(seen),
        Internal: failed(seen),
        ProtocolError: failed(seen),
        SignInWaiting: failed(seen),
      }),
    );

  /**
   * Ends `ended` on the server; whether the server confirmed it. With `revoke`, any of the
   * session's refresh tokens ends it, however other clients rotated them since. Without it, the
   * session's token signs it out, renewed first when it is about to expire.
   */
  const endOnServer = (ended: StoredSession): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (options.revoke !== undefined) {
        yield* callGateway(
          options.revoke,
          { refreshToken: Redacted.value(ended.refreshToken) },
          Option.none(),
          "mutation",
        );

        return true;
      }

      const now = yield* Clock.currentTimeMillis;

      const token = isExpiring(Redacted.value(ended.token), now)
        ? Option.map(
            yield* requestTokens(
              { refreshToken: Redacted.value(ended.refreshToken) },
              RefreshResult,
            ),
            (renewed) => renewed.token,
          )
        : Option.some(ended.token);

      if (Option.isSome(token)) yield* callGateway(SIGN_OUT, {}, token);

      return true;
    }).pipe(
      Effect.timeout(SERVER_SIGN_OUT_TIMEOUT),
      Effect.catch((error) =>
        options.revoke === undefined && SESSION_GONE.some((tag) => Predicate.isTagged(error, tag))
          ? Effect.succeed(true)
          : Effect.logWarning("Auth.serverSignOutFailed").pipe(
              Effect.annotateLogs({ reason: error.message }),
              Effect.as(false),
            ),
      ),
    );

  /**
   * Ends `ended` on the server. A sign-out (`signedOut`) is retried until the server confirms it or
   * another client records that it did. Until its revocation is stored (`recorded`), each try
   * writes it again, and nothing but the server's answer stops the retries. A renewal that was let
   * go of gets one attempt.
   */
  const endUntilConfirmed = (
    ended: StoredSession,
    signedOut: boolean,
    recorded: boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stored = yield* Ref.make(recorded);

      return yield* Effect.gen(function* () {
        if (signedOut && !(yield* Ref.get(stored))) {
          const wrote = yield* Effect.exit(storage.revoke(ended));

          yield* Ref.set(stored, Exit.isSuccess(wrote));
        }

        if (
          signedOut &&
          (yield* Ref.get(stored)) &&
          !(yield* storage.signOutPending(ended).pipe(Effect.orElseSucceed(() => true)))
        ) {
          return true;
        }

        if (yield* endOnServer(ended)) {
          if (signedOut) {
            yield* storage
              .confirmRevoked(ended)
              .pipe(Effect.catchTag("TokenStorageError", logStorageFailure));
          }

          return true;
        }

        return !signedOut;
      }).pipe(Effect.repeat({ schedule: renewalSchedule, until: (done) => done }));
    }).pipe(Effect.asVoid);

  /**
   * Ends `ended` on the server in the background, once per session, starting after `wait`. A
   * client that learned of another's sign-out waits, so the signing-out client usually confirms it
   * and the others send nothing.
   */
  const endInBackground = (
    ended: StoredSession,
    signedOut: boolean,
    wait: Duration.Duration = Duration.zero,
    recorded = true,
  ): Effect.Effect<void> =>
    Effect.asVoid(
      FiberMap.run(
        ending,
        Option.getOrElse(sessionOf(ended), () => Redacted.value(ended.refreshToken)),
        Effect.delay(endUntilConfirmed(ended, signedOut, recorded), wait),
        { onlyIfMissing: true },
      ),
    );

  /**
   * Takes over every sign-out left pending in the store, such as one whose client was disposed
   * with its slot before the server could confirm it.
   */
  const resumePendingSignOuts = Effect.gen(function* () {
    for (const ended of yield* storage.pendingSignOuts) {
      yield* endInBackground(ended, true, Duration.seconds(1));
    }
  });

  /** Stops using `revoked` at once, then ends it on the server in the background. */
  const drop = Effect.fn("Auth.drop")(function* (revoked: StoredSession) {
    if (Option.exists(yield* Ref.get(session), (held) => isSameSession(held, revoked))) {
      yield* adopt(Option.none());
    }

    yield* endInBackground(revoked, true, Duration.seconds(1));
  });

  const commitRefresh = Effect.fn("Auth.commitRefresh")(function* (
    seen: StoredSession,
    outcome: RefreshOutcome,
  ) {
    const current = yield* Ref.get(session);

    if (Option.isNone(current) || current.value !== seen) {
      // The refresh renewed a session this client has let go of, so end it on the server, unless
      // it is the session held now: signing in again with an API key reuses the key's session.
      if (
        RefreshOutcome.$is("Renewed")(outcome) &&
        !Option.exists(current, (held) => isSameSession(held, outcome.session))
      ) {
        yield* endInBackground(outcome.session, false);
      }

      return Option.map(current, (held) => held.token);
    }

    const holdRenewed = (renewed: StoredSession) =>
      Ref.set(session, Option.some(renewed)).pipe(Effect.andThen(reconnect));

    return yield* RefreshOutcome.$match(outcome, {
      Renewed: ({ session: renewed }) =>
        Effect.gen(function* () {
          const expected = Option.getOrElse(yield* Ref.get(lastStored), () => seen);

          const wrote = yield* storage
            .renew(expected, renewed)
            .pipe(Effect.tapError(() => holdRenewed(renewed)));

          if (!wrote) return yield* giveWayToStore(Option.some(renewed));
          yield* Ref.set(lastStored, Option.some(renewed));

          if ((yield* storage.revocation(renewed)) !== "none") {
            yield* drop(renewed);

            return Option.none<Redacted.Redacted>();
          }

          yield* holdRenewed(renewed);

          return Option.some(renewed.token);
        }),
      Refused: () =>
        Effect.gen(function* () {
          const stored = yield* storage.load;

          // Another client renewed this session first, so its refresh token is the live one.
          if (
            Option.exists(stored, (held) => isSameSession(held, seen)) &&
            !TokenStorage.sameStored(stored, yield* Ref.get(lastStored))
          ) {
            return yield* giveWayToStore(Option.none());
          }

          // A refused refresh token proves nothing about the session, which may still be live, so
          // it is signed out like any other and ended on the server.
          yield* adopt(Option.none());
          const recorded = yield* Effect.exit(storage.revoke(seen));

          yield* endInBackground(seen, true, Duration.zero, Exit.isSuccess(recorded));

          return Option.none<Redacted.Redacted>();
        }).pipe(Effect.tapError(() => adopt(Option.none()))),
      Kept: () => Effect.succeedSome(seen.token),
      Stalled: () => runSignedOut(seen).pipe(Effect.as(Option.none<Redacted.Redacted>())),
    });
  }, committing.withPermits(1));

  /**
   * Hands the connection no token, so it stops waiting for one and runs signed out, public
   * queries included, while the session stays stored and is renewed in the background.
   */
  const runSignedOut = Effect.fn("Auth.runSignedOut")(function* (seen: StoredSession) {
    if (yield* SubscriptionRef.get(reconnecting)) return;
    yield* SubscriptionRef.set(reconnecting, true);
    yield* transport.setAuth(null);
    yield* FiberHandle.run(renewal, renewInBackground(seen));
  });

  const reconnect = Effect.gen(function* () {
    if (!(yield* SubscriptionRef.get(reconnecting))) return;
    yield* transport.setAuth(tokenSource);
    yield* SubscriptionRef.set(reconnecting, false);
    yield* Effect.logInfo("Auth.reconnected");
  });

  /**
   * Adopts what another writer put in the store. The same session takes the renewed tokens without
   * touching the connection or the status; another session, or none, goes through `adopt`. It
   * never saves, clears, or ends a session on the server, because the writer did that.
   */
  const adoptStored = Effect.fn("Auth.adoptStored")(function* (
    stored: Option.Option<StoredSession>,
  ) {
    if (TokenStorage.sameStored(stored, yield* Ref.getAndSet(lastStored, stored))) return;
    const held = yield* Ref.get(session);

    if (TokenStorage.sameStored(stored, held)) return;

    if (Option.isSome(stored) && Option.isSome(held) && isSameSession(held.value, stored.value)) {
      yield* Ref.set(session, stored);
      yield* Ref.set(failing, Option.none());
      yield* reconnect;
    } else {
      yield* adopt(stored);
    }
  });

  /** Follows another writer. A held session that another client revoked is dropped. */
  const follow = Effect.fn("Auth.follow")(function* () {
    yield* resumePendingSignOuts;
    const held = yield* Ref.get(session);

    if (Option.isSome(held) && (yield* storage.revocation(held.value)) !== "none") {
      yield* drop(held.value);
    }

    yield* adoptStored(yield* storage.load);
  }, committing.withPermits(1));

  const endUnlessStored = (renewed: StoredSession, stored: Option.Option<StoredSession>) =>
    Option.exists(stored, (held) => isSameSession(held, renewed))
      ? Effect.void
      : endInBackground(renewed, false);

  const giveWayToStore = Effect.fn("Auth.giveWayToStore")(function* (
    renewed: Option.Option<StoredSession>,
  ) {
    const stored = yield* storage.load;

    if (Option.isSome(renewed)) yield* endUnlessStored(renewed.value, stored);
    yield* adoptStored(stored);

    return yield* currentToken;
  });

  /**
   * Retries the refresh of `seen` until the server renews or refuses it, or the session changes,
   * waiting longer each time up to the schedule's limit.
   */
  const renewInBackground = (seen: StoredSession): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(session);

      if (!(yield* SubscriptionRef.get(reconnecting)) || !Option.contains(current, seen)) {
        return false;
      }

      const { finished: generation } = yield* Ref.get(lastAttempt);

      yield* refresh(seen, generation, true).pipe(
        Effect.catchTag("TokenStorageError", logStorageFailure),
      );

      return yield* SubscriptionRef.get(reconnecting);
    }).pipe(
      Effect.repeat({ schedule: renewalSchedule, while: (again) => again }),
      Effect.delay(Duration.seconds(1)),
      Effect.asVoid,
    );

  const refresh = Effect.fn("Auth.refresh")(function* (
    seen: StoredSession,
    generation: number,
    forced: boolean,
  ) {
    const current = yield* Ref.get(session);

    if (Option.isNone(current) || current.value !== seen) {
      return Option.map(current, (held) => held.token);
    }

    const last = yield* Ref.get(lastAttempt);

    const keptSince =
      last.finished !== generation &&
      Option.exists(last.session, (tried) => tried === seen) &&
      (last.forced || !forced);

    if (keptSince) return Option.some(seen.token);

    const outcome = yield* requestRefresh(seen);

    yield* Ref.update(lastAttempt, (previous) => ({
      finished: previous.finished + 1,
      session: Option.some(seen),
      forced,
    }));

    return yield* commitRefresh(seen, outcome);
  }, refreshing.withPermits(1));

  function accessToken(
    forceRefresh: boolean,
  ): Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorage.TokenStorageError> {
    return Effect.gen(function* () {
      const current = yield* Ref.get(session);

      if (Option.isNone(current)) return Option.none();
      const { finished: generation } = yield* Ref.get(lastAttempt);
      const now = yield* Clock.currentTimeMillis;

      const token =
        !forceRefresh && !isExpiring(Redacted.value(current.value.token), now)
          ? Option.some(current.value.token)
          : yield* refresh(current.value, generation, forceRefresh);

      return yield* unlessRevoked(token);
    });
  }

  /**
   * `token`, unless the session held now was revoked, which drops it. A check that cannot read
   * the store counts as revoked, so no token leaves unchecked.
   */
  function unlessRevoked(
    token: Option.Option<Redacted.Redacted>,
  ): Effect.Effect<Option.Option<Redacted.Redacted>> {
    return Effect.gen(function* () {
      const held = yield* Ref.get(session);

      if (Option.isNone(token) || Option.isNone(held)) return token;

      const revocation = yield* storage
        .revocation(held.value)
        .pipe(
          Effect.catchTag("TokenStorageError", (error) =>
            logStorageFailure(error).pipe(Effect.as("pending" as const)),
          ),
        );

      if (revocation === "none") return token;
      yield* committing.withPermits(1)(drop(held.value));

      return Option.none();
    });
  }

  const open = Effect.fn("Auth.open")(function* (request: SignInRequest) {
    const opened = yield* requestTokens(
      { provider: request.provider, params: request.params },
      SignInResult,
    );

    if (Option.isNone(opened)) {
      return yield* new Unauthenticated({
        message: "Sign-in refused: the server did not accept these credentials",
      });
    }

    const stored = yield* committing.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* storage.save(opened.value))) return false;
        yield* Ref.set(lastStored, opened);
        yield* adopt(opened);

        return true;
      }),
    );

    if (stored) return sessionOf(opened.value);

    return yield* new Unauthenticated({
      message:
        "Sign-in refused: this session was signed out on this device meanwhile, or another sign-in holds its place",
    });
  });

  /**
   * Revokes the session in the store first, so every client stops using it, then ends it on the
   * server. Where the store keeps the sign-out pending for any client to finish, this returns once
   * it is stored and the server is told in the background; otherwise it waits for one attempt and
   * retries in the background while the server cannot confirm it.
   */
  const signOut = Effect.fn("Auth.signOut")(function* (expected: Option.Option<string>) {
    const { ended, revoked } = yield* committing.withPermits(1)(
      Effect.gen(function* () {
        const current = Option.filter(
          yield* Ref.get(session),
          (held) => Option.isNone(expected) || Option.contains(sessionOf(held), expected.value),
        );

        // A sign-out of a named session leaves whatever other session the client holds now.
        if (Option.isNone(current) && Option.isSome(expected)) {
          return { ended: current, revoked: Exit.void };
        }

        const exit = yield* Effect.exit(
          Option.match(current, { onNone: () => Effect.void, onSome: storage.revoke }),
        );

        yield* adopt(Option.none());

        return { ended: current, revoked: exit };
      }),
    );

    if (Option.isNone(ended)) {
      yield* revoked;

      return false;
    }

    const handedOver =
      Exit.isSuccess(revoked) &&
      (yield* storage.signOutPending(ended.value).pipe(Effect.orElseSucceed(() => false)));

    if (handedOver) {
      yield* endInBackground(ended.value, true);
    } else if (yield* endOnServer(ended.value)) {
      yield* storage
        .confirmRevoked(ended.value)
        .pipe(Effect.catchTag("TokenStorageError", logStorageFailure));
    } else {
      yield* endInBackground(ended.value, true, Duration.seconds(1), Exit.isSuccess(revoked));
    }

    yield* revoked;

    return true;
  });

  const stored = yield* storage.load;

  yield* Ref.set(lastStored, stored);
  yield* adopt(stored);
  yield* Effect.forkIn(
    Stream.runForEach(storage.changed, () =>
      follow().pipe(Effect.catchTag("TokenStorageError", logStorageFailure)),
    ),
    scope,
  );

  const engine: Engine = {
    status: SubscriptionRef.changes(status),
    currentStatus: SubscriptionRef.get(status),
    reconnecting: SubscriptionRef.changes(reconnecting),
    isReconnecting: SubscriptionRef.get(reconnecting),
    currentIdentity: Effect.map(Ref.get(session), Option.flatMap(sessionOf)),
    open,
    signOut: Effect.asVoid(signOut(Option.none())),
    signOutSession: (ended) => signOut(Option.some(ended)),
    accessToken,
  };

  return engine;
});

/**
 * `waiting` from a sign-in that should never wait, such as a password: the server is not the one
 * this client was built for.
 */
export const unexpectedWaiting = (waiting: SignInWaiting): ProtocolError =>
  new ProtocolError({
    operation: SIGN_IN,
    message: `Protocol error in auth:signIn: the server answered ${waiting.state}`,
    cause: waiting,
  });

/**
 * Builds the auth service over the movies backend's providers. Requires the connection and a
 * token store.
 */
export const make = Effect.fn("Auth.make")(function* (options: Options) {
  const engine = yield* makeEngine(options);

  return Auth.of({
    status: engine.status,
    currentStatus: engine.currentStatus,
    reconnecting: engine.reconnecting,
    isReconnecting: engine.isReconnecting,
    currentIdentity: engine.currentIdentity,
    signIn: (credentials) =>
      engine.open(providerParams(credentials)).pipe(
        Effect.asVoid,
        Effect.catchTag("SignInWaiting", (waiting) => Effect.fail(unexpectedWaiting(waiting))),
      ),
    signOut: engine.signOut,
    accessToken: engine.accessToken,
  });
});

/** The auth service over the given connection and token store. */
export const layer = (
  options: Options,
): Layer.Layer<
  Auth,
  TokenStorage.TokenStorageError,
  ConvexTransport.ConvexTransport | TokenStorage.TokenStorage
> => Layer.effect(Auth, make(options));
