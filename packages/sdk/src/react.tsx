/**
 * `@media/sdk/react`: the SDK in React. `PlatformProvider` opens the platform deployment's client:
 * `usePlatform()` gives every command as a Promise method and `usePlatformQuery` follows a query.
 * `MoviesProvider` runs the movies backend's client on the app's `ConvexReactClient`, so
 * `convex/react` subscriptions and the SDK share one WebSocket. Queries return a state instead of
 * throwing; commands return Promises that reject with the SDK's tagged errors.
 */
import type { CommandArgs, CommandName, CommandResult } from "@media/contracts/commands";
import type { DeviceId, MediaFileId, RoomId } from "@media/contracts/ids";
import type { ConvexReactClient } from "convex/react";
import { ConvexProvider } from "convex/react";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  type LogLevel,
  ManagedRuntime,
  Option,
  Redacted,
  References,
  Result,
  Scope,
  Stream,
} from "effect";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import * as Auth from "./auth";
import type { AuthStatus, PasswordSignIn } from "./auth";
import { ClientErrors } from "./client-errors";
import type { ErrorContext } from "./client-errors";
import * as DeviceLogin from "./device-login";
import type { PendingDeviceLogin } from "./device-login";
import type { PlaybackCallError } from "./media-http";
import * as Movies from "./movies";
import type { QueryName } from "./movies-client";
import { MoviesClient } from "./movies-client";
import * as Playback from "./playback";
import type { Params, PromiseQuery } from "./platform/command";
import { createPlatform } from "./platform/promise";
import type { PlatformSdk } from "./platform/promise";
import * as QueryWatch from "./query-watch";
import type { QueryState } from "./query-watch";
import * as ReactTransport from "./react-transport";
import type { PlayerPort } from "./room-sync/player-port";
import * as RoomPresence from "./room-sync/room-presence";
import * as RoomSync from "./room-sync/room-sync";
import type { RoomSyncState } from "./room-sync/room-sync";
import type { RoomSyncTunables } from "./room-sync/sync-policy";
import { DEFAULT_TUNABLES } from "./room-sync/sync-policy";
import type { CallError } from "./sdk-errors";
import * as TokenStorage from "./token-storage";
import type { SharedStore } from "./shared-store";
import type { KeyValueStore } from "./token-storage";

type Runtime = ManagedRuntime.ManagedRuntime<Movies.Services, Movies.OpenError>;

const RuntimeContext = createContext<Runtime | null>(null);

/** Props for `MoviesProvider`. */
export interface MoviesProviderProps {
  /** The app's Convex client; `convex/react` hooks below the provider use it too. */
  readonly client: ConvexReactClient;
  /** The media service URL for `media` commands. */
  readonly mediaUrl?: string;
  /** Where the session lives, such as `window.localStorage`. */
  readonly storage: KeyValueStore;
  /** The key the session is stored under; `movies.session` when omitted. */
  readonly storageKey?: string;
  /**
   * The least severe SDK log line the console shows; `Warn` when omitted, so the console shows
   * problems rather than the SDK's routine. `Debug` shows every request.
   */
  readonly logLevel?: LogLevel.LogLevel | undefined;
  readonly children: ReactNode;
}

/**
 * Provides the SDK and the Convex client to the tree. The runtime is created and disposed by one
 * effect, so React's development double mount (StrictMode) never leaves a disposed runtime in
 * use; children render once it exists.
 */
export const MoviesProvider = (props: MoviesProviderProps): ReactNode => {
  const { client, mediaUrl, storage, storageKey, logLevel = "Warn" } = props;
  const [runtime, setRuntime] = useState<Runtime | null>(null);

  useEffect(() => {
    const created = ManagedRuntime.make(
      Movies.layerWithTransport({
        convexUrl: client.url,
        mediaUrl: Option.fromNullishOr(mediaUrl),
      }).pipe(
        Layer.provide(ReactTransport.layer(client)),
        Layer.provide(TokenStorage.layerKeyValue(storage, storageKey ?? "movies.session")),
        Layer.merge(Layer.succeed(References.MinimumLogLevel, logLevel)),
      ),
    );

    setRuntime(created);

    return () => {
      setRuntime(null);
      void created.dispose();
    };
  }, [client, mediaUrl, storage, storageKey, logLevel]);

  if (runtime === null) return null;

  return (
    <ConvexProvider client={client}>
      <RuntimeContext.Provider value={runtime}>{props.children}</RuntimeContext.Provider>
    </ConvexProvider>
  );
};

/**
 * The SDK runtime, for running Effect workflows from components.
 *
 * @throws When used outside `MoviesProvider`, a programming error.
 */
export const useMoviesRuntime = (): Runtime => {
  const runtime = useContext(RuntimeContext);

  if (runtime === null) throw new Error("useMoviesRuntime must be used inside MoviesProvider");

  return runtime;
};

export type { QueryState } from "./query-watch";

/**
 * Subscribes to a query command, re-rendering on every change. Pass `"skip"` to wait. Arguments
 * the schema rejects report an `InvalidArgs` error without subscribing. Network failures and
 * rate limiting retry with backoff first; a failure carries `retry` for a Try again button.
 */
export const useCommandQuery = <Name extends QueryName>(
  name: Name,
  args: CommandArgs<Name> | "skip",
): QueryState<CommandResult<Name>> => {
  const runtime = useMoviesRuntime();
  const key = args === "skip" ? null : `${name}:${JSON.stringify(args)}`;

  const watchFor = (): QueryWatch.QueryWatch<CommandResult<Name>> =>
    args === "skip" ? QueryWatch.skipped : QueryWatch.make(runtime, name, args);

  // State rather than a memo: React may drop a memo, which would restart a live subscription.
  const [held, setHeld] = useState(() => ({ runtime, key, watch: watchFor() }));
  let current = held;

  if (held.runtime !== runtime || held.key !== key) {
    current = { runtime, key, watch: watchFor() };
    setHeld(current);
  }

  const { watch } = current;

  return useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
};

/** Returns a function that runs any command and resolves with its decoded result. */
export const useCommand = <Name extends CommandName>(
  name: Name,
): ((args: CommandArgs<Name>) => Promise<CommandResult<Name>>) => {
  const runtime = useMoviesRuntime();

  return useCallback(
    (args) => runtime.runPromise(Effect.flatMap(MoviesClient, (client) => client.run(name, args))),
    [runtime, name],
  );
};

export type { ErrorContext } from "./client-errors";

/**
 * Returns a function that writes an app's unexpected error to the media service's retained log.
 * It sends nothing while signed out, sends a repeated error once per short window, and never
 * throws.
 */
export const useReportError = (): ((cause: unknown, context: ErrorContext) => void) => {
  const runtime = useMoviesRuntime();

  return useCallback(
    (cause, context) => {
      runtime.runFork(Effect.flatMap(ClientErrors, (errors) => errors.report(cause, context)));
    },
    [runtime],
  );
};

/** The session's sign-in state and the ways to change it. */
export interface UseAuth {
  /** `loading` until the stored session has been read, then whether someone is signed in. */
  readonly status: AuthStatus;
  /**
   * Signs in or up with email and password and stores the session. Rejects with `Unauthenticated`
   * for wrong credentials, or `Forbidden` or `Conflict` for a sign-up without a valid invite.
   */
  readonly signInWithPassword: (credentials: PasswordSignIn) => Promise<void>;
  /** Signs in with a scoped API key. Rejects with `Unauthenticated` when the key is refused. */
  readonly signInWithApiKey: (key: string) => Promise<void>;
  /** Starts a device sign-in named `clientName`, as the approving person will see it. */
  readonly startDeviceLogin: (clientName: string) => Promise<PendingDeviceLogin>;
  /** Ends the session on the server when reachable, then forgets it locally. */
  readonly signOut: () => Promise<void>;
}

/** Signs in and out and reports the session's status. */
export const useAuth = (): UseAuth => {
  const runtime = useMoviesRuntime();

  const store = useMemo(() => {
    let status: AuthStatus = "loading";

    return {
      subscribe: (onChange: () => void) => {
        const fiber = runtime.runFork(
          Stream.runForEach(Stream.unwrap(Effect.map(Auth.Auth, (auth) => auth.status)), (next) =>
            Effect.sync(() => {
              status = next;
              onChange();
            }),
          ),
        );

        return () => {
          Effect.runFork(Fiber.interrupt(fiber));
        };
      },
      read: () => status,
    };
  }, [runtime]);

  const status = useSyncExternalStore(store.subscribe, store.read, store.read);

  return useMemo((): UseAuth => {
    const withAuth = <A, E>(f: (auth: Auth.Interface) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(Auth.Auth, f));

    return {
      status,
      signInWithPassword: (credentials) =>
        withAuth((auth) => auth.signIn(Auth.passwordCredentials(credentials))),
      signInWithApiKey: (key) =>
        withAuth((auth) => auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make(key) }))),
      startDeviceLogin: (clientName) => DeviceLogin.startOn(runtime, clientName),
      signOut: () => withAuth((auth) => auth.signOut),
    };
  }, [runtime, status]);
};

const useScoped = <A, E>(
  key: string | null,
  workflow: () => Effect.Effect<A, E, Movies.Services | Scope.Scope>,
): Result.Result<A, E> | null => {
  const runtime = useMoviesRuntime();
  const [outcome, setOutcome] = useState<Result.Result<A, E> | null>(null);

  useEffect(() => {
    if (key === null) return () => undefined;
    let active = true;
    const scope = Scope.makeUnsafe();

    const fiber = runtime.runFork(
      Scope.provide(scope)(workflow()).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            if (active) setOutcome(result);
          }),
        ),
      ),
    );

    return () => {
      active = false;
      setOutcome(null);
      // Neither step needs services, so this also stops the workflow when the provider disposed the
      // runtime first; the runtime's disposal would not close this scope.
      Effect.runFork(Effect.andThen(Fiber.interrupt(fiber), Scope.close(scope, Exit.void)));
    };
  }, [runtime, key]);

  return outcome;
};

/**
 * Keeps this device's place in a room while mounted, outside the room's player: heartbeats that
 * say the device is away, browsing, so the server neither drops it nor counts it as watching.
 * Null sends nothing. It stops on unmount; pass null once the device is no longer in the room.
 */
export const useRoomPresence = (input: RoomPresence.RoomPresenceOptions | null): void => {
  const key = input === null ? null : `${input.roomId}:${input.deviceId}`;

  useScoped(key, () => (input === null ? Effect.void : RoomPresence.keepAway(input)));
};

/** What `useRoomSync` needs. */
export interface RoomSyncInput {
  readonly roomId: RoomId;
  readonly deviceId: DeviceId;
  /** The file the player plays, so the engine knows when the room moved on from it. */
  readonly fileId?: MediaFileId | undefined;
  readonly tunables?: RoomSyncTunables;
}

/**
 * Keeps `player` on the room's shared timeline while mounted. Returns the engine's state, null
 * while starting or without a player, or the failure that kept it from starting.
 */
export const useRoomSync = (
  player: PlayerPort | null,
  input: RoomSyncInput | null,
): Result.Result<RoomSyncState, CallError> | null => {
  const runtime = useMoviesRuntime();
  const [state, setState] = useState<RoomSyncState | null>(null);

  const key =
    player === null || input === null
      ? null
      : `${input.roomId}:${input.deviceId}:${input.fileId ?? ""}`;

  const started = useScoped(key, () =>
    Effect.gen(function* () {
      if (player === null || input === null) return yield* Effect.die(new Error("No room input"));

      const sync = yield* RoomSync.run({
        roomId: input.roomId,
        deviceId: input.deviceId,
        player,
        tunables: input.tunables ?? DEFAULT_TUNABLES,
        fileId: input.fileId,
      });

      yield* Effect.forkScoped(
        Stream.runForEach(sync.state, (next) => Effect.sync(() => setState(next))),
      );

      return sync;
    }),
  );

  useEffect(() => {
    if (key === null) setState(null);
  }, [key, runtime]);

  if (started === null) return null;

  if (Result.isFailure(started)) return Result.fail(started.failure);

  return state === null ? null : Result.succeed(state);
};

/**
 * Starts playback for `request` and reports progress from `player` while mounted; unmounting ends
 * the session. Returns the negotiated playback, null while starting, or the failure.
 */
export const usePlaybackSession = (
  request: Playback.PlaybackRequest | null,
  player: PlayerPort | null,
): Result.Result<Playback.Playback, CallError | PlaybackCallError> | null => {
  const key =
    request === null || player === null
      ? null
      : JSON.stringify([
          request.profileId,
          request.deviceId,
          request.titleId,
          Option.getOrNull(request.episodeId),
          Option.getOrNull(request.fileId),
          Option.getOrNull(request.roomId),
        ]);

  return useScoped(key, () =>
    Effect.gen(function* () {
      if (request === null || player === null) {
        return yield* Effect.die(new Error("No playback input"));
      }

      const playback = yield* Playback.start(request);

      yield* Playback.reportProgress(playback, player);

      return playback;
    }),
  );
};

/** The session's status, read by every `usePlatformStatus` from one subscription. */
interface StatusStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly read: () => AuthStatus;
}

interface OpenPlatform {
  readonly platform: PlatformSdk;
  readonly status: StatusStore;
}

const PlatformContext = createContext<OpenPlatform | null>(null);

const followStatus = (platform: PlatformSdk): StatusStore => {
  let status: AuthStatus = "loading";
  const listeners = new Set<() => void>();

  void platform.session.onStatus((next) => {
    status = next;

    for (const listener of listeners) listener();
  });

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
    read: () => status,
  };
};

/** Props for `PlatformProvider`. */
export interface PlatformProviderProps {
  /** The platform deployment's URL. */
  readonly url: string;
  /** The media server's sign-in boundary, where every sign-in goes (ADR 0007). */
  readonly signInUrl: string;
  /**
   * Where the session lives: a `SharedStore` the origin's clients share, such as IndexedDB from
   * `openIndexedDb`, or a store this client owns. Pass the same object on every render: a new one
   * opens a new client and remounts the tree.
   */
  readonly storage: KeyValueStore | SharedStore;
  /**
   * The key the session is stored under; `media.session` when omitted, which every client on the
   * origin shares, so one sign-in serves them all (ADR 0020).
   */
  readonly storageKey?: string;
  readonly children: ReactNode;
}

/**
 * Opens the platform client for the tree over its own WebSocket. The client is created and
 * disposed by one effect, so React's development double mount never leaves a disposed client in
 * use; children render once it exists.
 */
export const PlatformProvider = (props: PlatformProviderProps): ReactNode => {
  const { url, signInUrl, storage, storageKey } = props;
  const [open, setOpen] = useState<OpenPlatform | null>(null);

  useEffect(() => {
    const platform = createPlatform({
      url,
      signInUrl,
      connection: "websocket",
      storage,
      storageKey,
    });

    setOpen({ platform, status: followStatus(platform) });

    return () => {
      setOpen(null);
      void platform.dispose();
    };
  }, [url, signInUrl, storage, storageKey]);

  if (open === null) return null;

  return <PlatformContext.Provider value={open}>{props.children}</PlatformContext.Provider>;
};

/**
 * Every platform command as a Promise method, such as `usePlatform().core.server.info()`, and the
 * session. The same object for the provider's lifetime.
 *
 * @throws When used outside `PlatformProvider`, a programming error.
 */
export const usePlatform = (): PlatformSdk => useOpenPlatform().platform;

const useOpenPlatform = (): OpenPlatform => {
  const open = useContext(PlatformContext);

  if (open === null) throw new Error("usePlatform must be used inside PlatformProvider");

  return open;
};

// SAFETY: a type predicate, not checked by the compiler. An arguments object is never the string
// `"skip"`.
const isSkipped = <Args,>(params: Params<Args> | readonly ["skip"]): params is readonly ["skip"] =>
  params[0] === "skip";

/**
 * Follows a platform query, re-rendering on every change: `usePlatformQuery(platform.core.server.info)`.
 * Pass `"skip"` in place of the arguments to wait. Network failures and rate limiting retry with
 * backoff first; a failure carries `retry` for a Try again button.
 */
export const usePlatformQuery = <Args, Result>(
  method: PromiseQuery<Args, Result>,
  ...params: Params<Args> | readonly ["skip"]
): QueryState<Result> => {
  const key = isSkipped(params) ? null : JSON.stringify(params[0] ?? {});

  const watchFor = (): QueryWatch.QueryWatch<Result> =>
    isSkipped(params) ? QueryWatch.skipped : method.watch(...params);

  // State rather than a memo: React may drop a memo, which would restart a live subscription.
  const [held, setHeld] = useState(() => ({ method, key, watch: watchFor() }));
  let current = held;

  if (held.method !== method || held.key !== key) {
    current = { method, key, watch: watchFor() };
    setHeld(current);
  }

  const { watch } = current;

  return useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
};

/**
 * The platform session's status: `loading` until the stored session has been read. Every caller
 * reads one subscription the provider holds, so a component that mounts later sees the status at
 * once.
 */
export const usePlatformStatus = (): AuthStatus => {
  const { status } = useOpenPlatform();

  return useSyncExternalStore(status.subscribe, status.read, status.read);
};
