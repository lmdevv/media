import { Unauthenticated } from "@media/contracts/errors";
import { Data, Effect, Fiber, ManagedRuntime, Match, Option, Redacted, Stream } from "effect";

import { SignInRoute } from "../auth";
import type { AuthStatus } from "../auth";
import type { FunctionKind } from "../convex-transport";
import * as QueryWatch from "../query-watch";
import * as TokenStorage from "../token-storage";
import type { SharedStore } from "../shared-store";
import type { KeyValueStore } from "../token-storage";
import * as Client from "./client";
import type { Command, Id, Params, PromiseBuilder } from "./command";
import { promiseMethods } from "./generated/commands";

/** Where the platform client connects and where it keeps its session. */
export interface PlatformOptions {
  /** The platform deployment's URL. */
  readonly url: string;
  /**
   * The media server's sign-in boundary, where every sign-in goes (ADR 0007): `signInUrlFor` the
   * server's address, or `signInUrlBeside` the platform's URL in an install.
   */
  readonly signInUrl: string;
  /**
   * The `fetch` sign-ins go through; the global one when omitted. A test that signs many people in
   * from one host passes one that names each as its own client, as a proxy does.
   */
  readonly signInFetch?: typeof fetch;
  /** `websocket` (default) for apps; `http` for short-lived scripts. */
  readonly connection?: "websocket" | "http";
  /**
   * Where the session's tokens live: a store this client owns, or a `SharedStore` the origin's
   * clients share, such as the browser's IndexedDB (`openIndexedDb`); memory when omitted.
   */
  readonly storage?: KeyValueStore | SharedStore;
  /**
   * The key the session is stored under; `media.session` when omitted. Clients on one origin that
   * use the same key share one sign-in (ADR 0020).
   */
  readonly storageKey?: string | undefined;
}

/** A username and password to sign in with. */
export interface PlatformPassword {
  readonly username: string;
  readonly password: string;
}

/** A new account from an invite code, with the username and password its holder picks. */
export interface PlatformInvite extends PlatformPassword {
  /** The code `core.accounts.invites.create` showed once. */
  readonly code: string;
}

/** A new password from a reset link code. */
export interface PlatformReset {
  /** The code `core.accounts.resetLinks.create` showed once. */
  readonly code: string;
  readonly password: string;
}

/** What lets a person past their tile's lock, as `Credentials.Tile` describes it. */
export type PlatformTileProof =
  | { readonly kind: "password"; readonly by: Id<"users">; readonly password: string }
  | { readonly kind: "code"; readonly by: Id<"users">; readonly code: string }
  | { readonly kind: "approval"; readonly approvalId: Id<"tileApprovals"> };

/** A person's tile on a shared device, and the proof for a locked one. */
export interface PlatformTile {
  /** The shared device's code, `dv_` and its secret. */
  readonly device: string;
  readonly userId: Id<"users">;
  readonly proof?: PlatformTileProof;
}

/** A device grant and the person it signs in, as a phone's shared keychain keeps them. */
export interface PlatformGrant {
  readonly userId: Id<"users">;
  /** The grant `core.devices.deviceGrants.issue` showed, `dg_` and its secret. */
  readonly grant: string;
}

/** A device sign-in waiting for approval. */
export interface PendingDeviceSignIn {
  /** The short code the person approving types or confirms. */
  readonly userCode: string;
  /** When the server stops accepting approval, in epoch milliseconds. */
  readonly expiresAt: number;
  /**
   * Waits until the server approves, denies, or expires the code, then signs this client in.
   * Rejects with `DeviceSignInRefused` once the code is denied or expired.
   */
  readonly complete: () => Promise<void>;
}

type Stop = () => Promise<void>;

/** The client's sign-in state and the ways to change it. */
export interface PlatformSession {
  /** The status now: `loading` until the stored session has been read. */
  readonly status: () => Promise<AuthStatus>;
  /** Calls `listener` with the current status and every change. */
  readonly onStatus: (listener: (status: AuthStatus) => void) => Stop;
  /** Signs in with a username and password. Rejects with `Unauthenticated` when refused. */
  readonly signInWithPassword: (credentials: PlatformPassword) => Promise<void>;
  /** Signs in with an API key. Rejects with `Unauthenticated` when the key is refused. */
  readonly signInWithApiKey: (key: string) => Promise<void>;
  /**
   * Creates the server's first account as its owner and signs in. Rejects with `Conflict` once the
   * server has an owner.
   */
  readonly setUpOwner: (credentials: PlatformPassword) => Promise<void>;
  /** Creates an account from an invite and signs in. Rejects with `Expired` for a dead invite. */
  readonly acceptInvite: (invite: PlatformInvite) => Promise<void>;
  /**
   * Sets a new password from a reset link and signs in, ending the account's other sessions and
   * keys. Rejects with `Expired` for a used or expired link.
   */
  readonly resetPassword: (reset: PlatformReset) => Promise<void>;
  /** Starts a device sign-in named `clientName`, as the person approving it will see it. */
  readonly startDeviceSignIn: (clientName: string) => Promise<PendingDeviceSignIn>;
  /**
   * Opens a tile on a shared device and signs in as its person, ending the session that held the
   * device. Rejects with `Forbidden` for a locked tile without a proof that lifts the lock.
   */
  readonly openTile: (tile: PlatformTile) => Promise<void>;
  /**
   * Exchanges the device's grant for a session of this app's own; enroll the app's device next.
   * Rejects with `Unauthenticated` for a revoked, stale, or someone else's grant: ask for the
   * password then (D59).
   */
  readonly exchangeGrant: (grant: PlatformGrant) => Promise<void>;
  /** Ends the session on the server when reachable, then forgets it locally. */
  readonly signOut: () => Promise<void>;
  /**
   * The session's current auth token, for the media server's own routes as a bearer token; null
   * while signed out. Never log or store it.
   */
  readonly accessToken: () => Promise<string | null>;
  /**
   * Calls `use` with the token `accessToken` gives, for a request to another server such as the
   * media server's own routes, under the refusal rule every platform call follows: when `use`
   * rejects with `Unauthenticated` and the session is still the one the token belongs to, the
   * session refreshes once and the rejection comes back; when the session was renewed since,
   * `use` runs once more with the token held now. Never log or store the token.
   */
  readonly refreshOnRefusal: <A>(use: (token: string | null) => Promise<A>) => Promise<A>;
}

type PromiseMethods = ReturnType<typeof promiseMethods>;

/** The platform client as Promises. */
export interface PlatformSdk extends PromiseMethods {
  readonly session: PlatformSession;
  /** Closes the connection and stops every watch. */
  readonly dispose: () => Promise<void>;
}

const DEFAULT_STORAGE_KEY = "media.session";

/** A rejection of `refreshOnRefusal`'s `use` other than a refusal, carried back to its caller. */
class UseRejected extends Data.TaggedError("UseRejected")<{ readonly rejection: unknown }> {}

const tileProof = Match.type<PlatformTileProof>().pipe(
  Match.discriminatorsExhaustive("kind")({
    password: ({ by, password }) =>
      Client.TileProof.Password({ by, password: Redacted.make(password) }),
    code: ({ by, code }) => Client.TileProof.Code({ by, code: Redacted.make(code) }),
    approval: ({ approvalId }) => Client.TileProof.Approval({ approvalId }),
  }),
);

const storageLayer = (storage: KeyValueStore | SharedStore | undefined, key: string) => {
  if (storage === undefined) return TokenStorage.layerMemory;

  return "write" in storage
    ? TokenStorage.layerShared(storage)
    : TokenStorage.layerKeyValue(storage, key);
};

/** Opens the platform client. The connection opens on the first call. */
export const createPlatform = (options: PlatformOptions): PlatformSdk => {
  const runtime = ManagedRuntime.make(
    Client.layer({
      url: options.url,
      connection: options.connection ?? "websocket",
      storage: storageLayer(options.storage, options.storageKey ?? DEFAULT_STORAGE_KEY),
      signIn:
        options.signInFetch === undefined
          ? SignInRoute.Boundary({ url: options.signInUrl })
          : SignInRoute.Boundary({ url: options.signInUrl, fetch: options.signInFetch }),
    }),
  );

  const withClient = <A, E>(f: (client: Client.Interface) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Client.Client, f));

  const call =
    <Kind extends FunctionKind, Args, Result>(command: Command<Kind, Args, Result>) =>
    (...params: Params<Args>) =>
      withClient((client) => client.run(command, params));

  const watchOf =
    <Args, Result>(command: Command<"query", Args, Result>) =>
    (...params: Params<Args>) =>
      QueryWatch.fromStream(
        runtime,
        Stream.unwrap(Effect.map(Client.Client, (client) => client.watch(command, params))),
      );

  const builder: PromiseBuilder = {
    query: (command) => Object.assign(call(command), { watch: watchOf(command) }),
    mutation: call,
    action: call,
  };

  const onStatus: PlatformSession["onStatus"] = (listener) => {
    const fiber = runtime.runFork(
      Stream.runForEach(
        Stream.unwrap(Effect.map(Client.Client, (client) => client.session.status)),
        (status) => Effect.sync(() => listener(status)),
      ),
    );

    return () => Effect.runPromise(Fiber.interrupt(fiber));
  };

  return {
    ...promiseMethods(builder),
    session: {
      status: () => withClient((client) => client.session.currentStatus),
      onStatus,
      signInWithPassword: ({ username, password }) =>
        withClient((client) =>
          client.session.signIn(
            Client.Credentials.Password({ username, password: Redacted.make(password) }),
          ),
        ),
      signInWithApiKey: (key) =>
        withClient((client) =>
          client.session.signIn(Client.Credentials.ApiKey({ key: Redacted.make(key) })),
        ),
      setUpOwner: ({ username, password }) =>
        withClient((client) =>
          client.session.signIn(
            Client.Credentials.Setup({ username, password: Redacted.make(password) }),
          ),
        ),
      acceptInvite: ({ code, username, password }) =>
        withClient((client) =>
          client.session.signIn(
            Client.Credentials.Invite({
              code: Redacted.make(code),
              username,
              password: Redacted.make(password),
            }),
          ),
        ),
      resetPassword: ({ code, password }) =>
        withClient((client) =>
          client.session.signIn(
            Client.Credentials.Reset({
              code: Redacted.make(code),
              password: Redacted.make(password),
            }),
          ),
        ),
      startDeviceSignIn: async (clientName) => {
        const pending = await withClient((client) => client.session.startDeviceSignIn(clientName));

        return {
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
          complete: () => runtime.runPromise(pending.complete),
        };
      },
      openTile: ({ device, userId, proof }) =>
        withClient((client) =>
          client.session.signIn(
            Client.Credentials.Tile({
              device: Redacted.make(device),
              userId,
              proof: Option.map(Option.fromUndefinedOr(proof), tileProof),
            }),
          ),
        ),
      exchangeGrant: ({ userId, grant }) =>
        withClient((client) =>
          client.session.signIn(Client.Credentials.Grant({ userId, grant: Redacted.make(grant) })),
        ),
      signOut: () => withClient((client) => client.session.signOut),
      accessToken: () =>
        withClient((client) =>
          Effect.map(client.session.accessToken, (token) =>
            Option.match(token, { onNone: () => null, onSome: Redacted.value }),
          ),
        ),
      refreshOnRefusal: (use) =>
        withClient((client) =>
          client.session
            .refreshOnRefusal((token) =>
              Effect.tryPromise({
                try: () => use(Option.match(token, { onNone: () => null, onSome: Redacted.value })),
                catch: (rejection) =>
                  rejection instanceof Unauthenticated ? rejection : new UseRejected({ rejection }),
              }),
            )
            .pipe(
              // Any other rejection goes back to the caller's promise as it came.
              Effect.catchTag("UseRejected", ({ rejection }) => Effect.die(rejection)),
            ),
        ),
    },
    dispose: () => runtime.dispose(),
  };
};
