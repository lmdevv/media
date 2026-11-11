import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";

import * as Auth from "../auth";
import type { AuthStatus, SignInRequest, SignInWaiting } from "../auth";
import { acrossReconnects, decodeResult, encodeArgs } from "../calls";
import * as ConvexTransport from "../convex-transport";
import type { CallError, TransportError } from "../sdk-errors";
import { ProtocolError } from "../sdk-errors";
import type { TokenStorage, TokenStorageError } from "../token-storage";
import type { Command, EffectBuilder, Id, Params, PlatformError } from "./command";
import { effectMethods } from "./generated/commands";

/** What lets a person past their tile's lock on a shared device. */
export type TileProof = Data.TaggedEnum<{
  /** The password of `by`, the person themself or an adult who may open the tile. */
  Password: { readonly by: Id<"users">; readonly password: Redacted.Redacted };
  /** The unlock code of `by`, which works only on this device. */
  Code: { readonly by: Id<"users">; readonly code: Redacted.Redacted };
  /** An `open` request that someone approved from another device. */
  Approval: { readonly approvalId: Id<"tileApprovals"> };
}>;

export const TileProof = Data.taggedEnum<TileProof>();

/** What to sign in with. Each case is one of the platform's sign-in providers. */
export type Credentials = Data.TaggedEnum<{
  /** A username and its password. */
  Password: { readonly username: string; readonly password: Redacted.Redacted };
  /** An API key, as `core.auth.apiKeys.create` shows it once. */
  ApiKey: { readonly key: Redacted.Redacted };
  /** The server's first account, which becomes its owner. Accepted only while it has none. */
  Setup: { readonly username: string; readonly password: Redacted.Redacted };
  /** A new account from an invite code, as `core.accounts.invites.create` shows it once. */
  Invite: {
    readonly code: Redacted.Redacted;
    readonly username: string;
    readonly password: Redacted.Redacted;
  };
  /** A new password from a reset link code, as `core.accounts.resetLinks.create` shows it once. */
  Reset: { readonly code: Redacted.Redacted; readonly password: Redacted.Redacted };
  /**
   * Opens the tile of `userId` on the shared device whose code is `device`, as a tile session
   * with content scopes only. It ends the session that held the device's slot. A locked tile
   * without a proof that lifts the lock fails with `Forbidden`, and a wrong password or code with
   * `Unauthenticated`. An approval fails with `Expired` once used or expired, and with
   * `ProtocolError` while still pending or after a refusal: redeem only an approved one.
   */
  Tile: {
    readonly device: Redacted.Redacted;
    readonly userId: Id<"users">;
    readonly proof: Option.Option<TileProof>;
  };
  /**
   * Exchanges the grant a phone or tablet keeps for `userId`, as
   * `core.devices.deviceGrants.issue` shows it, for a session of this app's own (ADR 0006). Enroll
   * the app's device afterwards, so it shows as its own device. A grant that was revoked, belongs
   * to someone else, or stopped when its person signed out everywhere fails with
   * `Unauthenticated`: ask for the password then.
   */
  Grant: { readonly userId: Id<"users">; readonly grant: Redacted.Redacted };
}>;

/** Constructors and matchers for `Credentials`. */
export const Credentials = Data.taggedEnum<Credentials>();

/** The device sign-in was denied, or expired before anyone approved it. Start a new one. */
export class DeviceSignInRefused extends Schema.TaggedError<DeviceSignInRefused>()(
  "DeviceSignInRefused",
  {
    state: Schema.Literals(["denied", "expired"]),
    message: Schema.String,
  },
) {}

/** A device sign-in waiting for someone signed in elsewhere to approve its code. */
export interface DeviceSignIn {
  /** The short code the person approving types or confirms. */
  readonly userCode: string;
  /** When the server stops accepting approval, in epoch milliseconds by the server's clock. */
  readonly expiresAt: number;
  /**
   * Asks the server every interval it names until it approves, denies, or expires the code, then
   * signs this client in. The server decides expiry, so a skewed local clock cannot end the wait
   * early. Interrupt it to stop waiting sooner.
   */
  readonly complete: Effect.Effect<void, DeviceSignInRefused | PlatformError | TokenStorageError>;
}

/** The client's sign-in state and the ways to change it. */
export interface Session {
  /** The current status, then every change; `loading` until the stored session has been read. */
  readonly status: Stream.Stream<AuthStatus>;
  /** The status now, without waiting for a change. */
  readonly currentStatus: Effect.Effect<AuthStatus>;
  /**
   * Signs in and stores the session. Refused credentials fail with `Unauthenticated`, a setup once
   * the server has an owner with `Conflict`, and a used or expired invite or reset code with
   * `Expired`.
   */
  readonly signIn: (
    credentials: Credentials,
  ) => Effect.Effect<void, PlatformError | TokenStorageError>;
  /** Starts a device sign-in named `clientName`, as the person approving it will see it. */
  readonly startDeviceSignIn: (clientName: string) => Effect.Effect<DeviceSignIn, PlatformError>;
  /** Ends the session on the server when reachable, then forgets it locally. */
  readonly signOut: Effect.Effect<void, TokenStorageError>;
  /**
   * The session's current Convex auth token, renewed first when it is about to expire, for a
   * request to the media server's own routes as a bearer token. None while signed out. It passes
   * the same check as every token the client sends, so a signed-out session never hands one out.
   */
  readonly accessToken: Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorageError>;
}

/** Runs platform commands as the signed-in session. */
export interface Interface {
  /** Runs `command` once with the arguments in `params`. */
  readonly run: <Kind extends ConvexTransport.FunctionKind, Args, Result>(
    command: Command<Kind, Args, Result>,
    params: Params<Args>,
  ) => Effect.Effect<Result, PlatformError>;
  /** The query's result now and after every change, kept across reconnects. */
  readonly watch: <Args, Result>(
    command: Command<"query", Args, Result>,
    params: Params<Args>,
  ) => Stream.Stream<Result, PlatformError>;
  /** Every command as an Effect method, nested by name. */
  readonly methods: EffectMethods;
  readonly session: Session;
}

/** Every command as an Effect method: `methods.core.server.info()` runs `core.server.info`. */
export type EffectMethods = ReturnType<typeof effectMethods>;

/** The platform client. Internal: the entry points expose it as methods. */
export class Client extends Context.Service<Client, Interface>()("@media/sdk/platform/Client") {}

/** Where the client connects, how, and where it keeps its session. */
export interface Options {
  /** The platform deployment's URL. */
  readonly url: string;
  /**
   * `websocket` keeps one connection with pushed subscriptions, for apps. `http` makes one-shot
   * requests and polls subscriptions, for short-lived processes such as the CLI.
   */
  readonly connection: "websocket" | "http";
  /**
   * Where the session's tokens live. Clients that share a store share one session, as the web
   * clients on one origin do (ADR 0020).
   */
  readonly storage: Layer.Layer<TokenStorage, TokenStorageError>;
  /**
   * Where sign-ins go: the media server's sign-in boundary, `Boundary` at `signInUrlFor` the
   * server, as every client signs in (ADR 0007). The core refuses a sign-in that skipped it.
   */
  readonly signIn: Auth.SignInRoute;
}

/** Opening the client fails when the URL is invalid or the stored session cannot be read. */
export type OpenError = TransportError | TokenStorageError;

const toPlatformError =
  (operation: string) =>
  (error: CallError): PlatformError =>
    Match.value(error).pipe(
      Match.tag(
        "StaleRevision",
        (stale) =>
          new ProtocolError({
            operation,
            message: `Protocol error in ${operation}: the platform answered stale_revision`,
            cause: stale,
          }),
      ),
      Match.orElse((other) => other),
    );

const tileProofParams = (proof: TileProof) =>
  TileProof.$match(proof, {
    Password: ({ by, password }) => ({ kind: "password", by, password: Redacted.value(password) }),
    Code: ({ by, code }) => ({ kind: "code", by, code: Redacted.value(code) }),
    Approval: ({ approvalId }) => ({ kind: "approval", approvalId }),
  });

const askAgain = (error: CallError | SignInWaiting | TokenStorageError): boolean =>
  Match.value(error).pipe(
    Match.tags({
      SignInWaiting: (waiting) => waiting.state === "pending",
      TransportError: () => true,
      RateLimited: () => true,
    }),
    Match.orElse(() => false),
  );

const effectBuilder = (client: Pick<Interface, "run" | "watch">): EffectBuilder => {
  const call =
    <Kind extends ConvexTransport.FunctionKind, Args, Result>(
      command: Command<Kind, Args, Result>,
    ) =>
    (...params: Params<Args>) =>
      client.run(command, params);

  const watchOf =
    <Args, Result>(command: Command<"query", Args, Result>) =>
    (...params: Params<Args>) =>
      client.watch(command, params);

  return {
    query: (command) => Object.assign(call(command), { watch: watchOf(command) }),
    mutation: call,
    action: call,
  };
};

const make = Effect.fn("Platform.make")(function* (url: string, signInRoute: Auth.SignInRoute) {
  const transport = yield* ConvexTransport.ConvexTransport;

  const engine = yield* Auth.makeEngine({
    convexUrl: url,
    revoke: "core/auth/sessions:revoke",
    signIn: signInRoute,
  });

  const refreshAfterRefusal = engine
    .accessToken(true)
    .pipe(
      Effect.catchTag("TokenStorageError", (error) =>
        Effect.logWarning("Platform.sessionStorageFailed").pipe(
          Effect.annotateLogs({ operation: error.operation, message: error.message }),
        ),
      ),
    );

  const run: Interface["run"] = (command, params) => {
    const [args] = params;

    return encodeArgs(command.name, command.args, args).pipe(
      Effect.flatMap((wire) => transport.call(command.kind, command.path, wire)),
      Effect.flatMap((raw) => decodeResult(command.name, command.result, raw)),
      Effect.mapError(toPlatformError(command.name)),
      Effect.tapErrorTag("Unauthenticated", () => refreshAfterRefusal),
      Effect.withSpan("Platform.call", { attributes: { command: command.name } }),
    );
  };

  const watch: Interface["watch"] = (command, params) => {
    const [args] = params;

    return Stream.unwrap(
      Effect.map(encodeArgs(command.name, command.args, args), (wire) =>
        acrossReconnects(
          engine,
          transport
            .subscribe(command.path, wire)
            .pipe(Stream.mapEffect((raw) => decodeResult(command.name, command.result, raw))),
        ),
      ),
    ).pipe(
      Stream.mapError(toPlatformError(command.name)),
      Stream.tapErrorTag("Unauthenticated", () => refreshAfterRefusal),
    );
  };

  const methods = effectMethods(effectBuilder({ run, watch }));

  const open = (request: SignInRequest) =>
    engine.open(request).pipe(
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag("SignInWaiting", Auth.unexpectedWaiting),
          Match.tag("TokenStorageError", (storage) => storage),
          Match.orElse(toPlatformError("auth:signIn")),
        ),
      ),
    );

  const signIn = (credentials: Credentials) =>
    open(
      Credentials.$match(credentials, {
        Password: ({ username, password }) => ({
          provider: "password",
          params: { username, password: Redacted.value(password) },
        }),
        ApiKey: ({ key }) => ({ provider: "apiKey", params: { key: Redacted.value(key) } }),
        Setup: ({ username, password }) => ({
          provider: "setup",
          params: { username, password: Redacted.value(password) },
        }),
        Invite: ({ code, username, password }) => ({
          provider: "invite",
          params: { code: Redacted.value(code), username, password: Redacted.value(password) },
        }),
        Reset: ({ code, password }) => ({
          provider: "reset",
          params: { code: Redacted.value(code), password: Redacted.value(password) },
        }),
        Grant: ({ userId, grant }) => ({
          provider: "grant",
          params: { userId, grant: Redacted.value(grant) },
        }),
        Tile: ({ device, userId, proof }) => ({
          provider: "tile",
          params: {
            device: Redacted.value(device),
            userId,
            ...Option.match(proof, {
              onNone: () => ({}),
              onSome: (value) => ({ proof: tileProofParams(value) }),
            }),
          },
        }),
      }),
    );

  const startDeviceSignIn = Effect.fn("Platform.startDeviceSignIn")(function* (clientName: string) {
    const started = yield* methods.core.auth.deviceCodes.start({ clientName });

    const complete = engine
      .open({ provider: "deviceCode", params: { deviceCode: started.deviceCode } })
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced(Duration.seconds(started.intervalSeconds)),
          while: askAgain,
        }),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tag(
              "SignInWaiting",
              (waiting) =>
                new DeviceSignInRefused({
                  state: waiting.state === "denied" ? "denied" : "expired",
                  message: waiting.message,
                }),
            ),
            Match.tag(
              "Expired",
              (expired) => new DeviceSignInRefused({ state: "expired", message: expired.message }),
            ),
            Match.tag("TokenStorageError", (storage) => storage),
            Match.orElse(toPlatformError("auth:signIn")),
          ),
        ),
      );

    const pending: DeviceSignIn = {
      userCode: started.userCode,
      expiresAt: started.expiresAt,
      complete,
    };

    return pending;
  });

  return Client.of({
    run,
    watch,
    methods,
    session: {
      status: engine.status,
      currentStatus: engine.currentStatus,
      signIn,
      startDeviceSignIn,
      signOut: engine.signOut,
      accessToken: engine.accessToken(false),
    },
  });
});

/** The client of the platform at `options.url`, over a connection and a session of its own. */
export const layer = (options: Options): Layer.Layer<Client, OpenError> =>
  Layer.effect(Client, make(options.url, options.signIn)).pipe(
    Layer.provide(
      Layer.merge(
        options.connection === "websocket"
          ? ConvexTransport.layerWebSocket(options.url)
          : ConvexTransport.layerHttp(options.url),
        options.storage,
      ),
    ),
  );
