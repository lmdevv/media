/**
 * `@media/sdk/promise`: the SDK for code that does not use Effect. It runs the Effect core in a
 * `ManagedRuntime`. Promises reject with the same tagged errors the Effect API fails with
 * (`Unauthenticated`, `NotFound`, `TransportError`, ...), so callers branch on `error._tag`.
 * `createPlatform` opens the platform deployment's client; `createMovies` opens the movies
 * backend's.
 */
import type { CommandArgs, CommandName, CommandResult } from "@media/contracts/commands";
import type { DeviceId, RoomId } from "@media/contracts/ids";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Scope,
  Stream,
} from "effect";

import * as Auth from "./auth";
import type { AuthStatus, PasswordSignIn } from "./auth";
import * as DeviceLogin from "./device-login";
import type { PendingDeviceLogin } from "./device-login";
import * as Movies from "./movies";
import type { ActionName, MediaName, MutationName, QueryName } from "./movies-client";
import { MoviesClient } from "./movies-client";
import * as Playback from "./playback";
import type { PlayerPort } from "./room-sync/player-port";
import * as RoomSync from "./room-sync/room-sync";
import type { RoomSyncState } from "./room-sync/room-sync";
import type { RoomSyncTunables } from "./room-sync/sync-policy";
import { DEFAULT_TUNABLES } from "./room-sync/sync-policy";
import * as TokenStorage from "./token-storage";
import type { KeyValueStore } from "./token-storage";

/** Where to connect and where to keep the session. */
export interface MoviesOptions {
  /** The Convex deployment URL. */
  readonly convexUrl: string;
  /** The media service URL for `media` commands. */
  readonly mediaUrl?: string;
  /** `websocket` (default) for apps; `http` for short-lived scripts. */
  readonly connection?: "websocket" | "http";
  /** Where the session's tokens live; memory when omitted. */
  readonly storage?: KeyValueStore;
  /** The key the session is stored under; `movies.session` when omitted. */
  readonly storageKey?: string;
}

/** Stops a subscription or a running workflow. */
export type Stop = () => Promise<void>;

export type { PasswordSignIn } from "./auth";

export { createPlatform } from "./platform/promise";

export { openIndexedDb } from "./shared-store";

export type { Channel, IdbFactory, SharedStore, SharedTransaction } from "./shared-store";

export type {
  PendingDeviceSignIn,
  PlatformInvite,
  PlatformOptions,
  PlatformPassword,
  PlatformReset,
  PlatformSdk,
  PlatformSession,
  PlatformTile,
  PlatformTileProof,
} from "./platform/promise";

export type { PendingDeviceLogin } from "./device-login";

/** A running room engine. */
export interface RoomSyncHandle {
  /** The engine's state now. */
  readonly current: () => Promise<RoomSyncState>;
  /** Calls `listener` with the current state and every change; returns a function that stops. */
  readonly subscribe: (listener: (state: RoomSyncState) => void) => Stop;
  /** Stops following the room and restores the player's rate. Resolves after `dispose` too. */
  readonly stop: Stop;
}

/** The SDK as Promises. */
export interface MoviesSdk {
  /** Runs a query command once. */
  readonly query: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /**
   * Runs a mutation command. When it rejects with `TransportError` it may still have run; read
   * the state again before retrying.
   */
  readonly mutate: <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /** Runs an action command, such as one that calls another service. */
  readonly action: <Name extends ActionName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /**
   * Runs a media service command with the session's token. Rejects with `TransportError` when no
   * `mediaUrl` was given.
   */
  readonly media: <Name extends MediaName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /** Runs any command, choosing the transport by its kind. */
  readonly run: <Name extends CommandName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /** Calls `onValue` with the query's result now and after every change. */
  readonly subscribe: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
    onValue: (value: CommandResult<Name>) => void,
    onError: (error: Error) => void,
  ) => Stop;
  /** Signing in and out. */
  readonly auth: {
    /** The status now: `loading` until the stored session has been read. */
    readonly status: () => Promise<AuthStatus>;
    /** Calls `listener` with the current status and every change. */
    readonly onStatus: (listener: (status: AuthStatus) => void) => Stop;
    /**
     * Signs in or up with email and password and stores the session. Rejects with
     * `Unauthenticated` for wrong credentials, or `Forbidden` or `Conflict` for a sign-up without a
     * valid invite.
     */
    readonly signInWithPassword: (credentials: PasswordSignIn) => Promise<void>;
    /** Signs in with a scoped API key. Rejects with `Unauthenticated` when the key is refused. */
    readonly signInWithApiKey: (key: string) => Promise<void>;
    /** Starts a device sign-in named `clientName`, as the approving person will see it. */
    readonly startDeviceLogin: (clientName: string) => Promise<PendingDeviceLogin>;
    /** Ends the session on the server when reachable, then forgets it locally. */
    readonly signOut: () => Promise<void>;
  };
  /** Playback sessions. */
  readonly playback: {
    /** Negotiates a stream for `request`. */
    readonly start: (request: Playback.PlaybackRequest) => Promise<Playback.Playback>;
    /** Reports progress until stopped; stopping ends the session. */
    readonly reportProgress: (playback: Playback.Playback, player: PlayerPort) => Promise<Stop>;
  };
  /** Watch rooms. */
  readonly rooms: {
    /**
     * Keeps `player` on the room's shared timeline until stopped. Rejects when the room cannot be
     * read.
     */
    readonly sync: (
      roomId: RoomId,
      deviceId: DeviceId,
      player: PlayerPort,
      tunables?: RoomSyncTunables,
    ) => Promise<RoomSyncHandle>;
  };
  /** Closes the connection and stops everything still running. */
  readonly dispose: () => Promise<void>;
}

/** Opens the SDK. The connection opens lazily on the first call. */
export const createMovies = (options: MoviesOptions): MoviesSdk => {
  const storage =
    options.storage === undefined
      ? TokenStorage.layerMemory
      : TokenStorage.layerKeyValue(options.storage, options.storageKey ?? "movies.session");

  const runtime = ManagedRuntime.make(
    Movies.layer({
      convexUrl: options.convexUrl,
      mediaUrl: Option.fromNullishOr(options.mediaUrl),
      connection: options.connection ?? "websocket",
    }).pipe(Layer.provide(storage)),
  );

  const client = <A, E>(f: (client: MoviesClient["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(MoviesClient, f));

  const auth = <A, E>(f: (auth: Auth.Interface) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Auth.Auth, f));

  // Each workflow runs in a scope forked from this one, so `dispose` stops every one still running:
  // disposing the runtime interrupts the fibers it started, not the ones forked into a scope.
  const workflows = Scope.makeUnsafe();

  const listen = <A, E>(
    stream: Stream.Stream<A, E, Movies.Services>,
    listener: (value: A) => void,
    onError: (error: E) => void,
  ): Stop => {
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (value) => Effect.sync(() => listener(value))).pipe(
        Effect.tapError((error) => Effect.sync(() => onError(error))),
      ),
    );

    return () => Effect.runPromise(Fiber.interrupt(fiber));
  };

  const scoped = async <A, E>(
    workflow: Effect.Effect<A, E, Movies.Services | Scope.Scope>,
  ): Promise<{ readonly value: A; readonly stop: Stop }> => {
    const scope = Scope.forkUnsafe(workflows);
    const stop: Stop = () => Effect.runPromise(Scope.close(scope, Exit.void));

    try {
      return { value: await runtime.runPromise(Scope.provide(scope)(workflow)), stop };
    } catch (error) {
      await stop();

      throw error;
    }
  };

  return {
    query: (name, args) => client((movies) => movies.query(name, args)),
    mutate: (name, args) => client((movies) => movies.mutate(name, args)),
    action: (name, args) => client((movies) => movies.action(name, args)),
    media: (name, args) => client((movies) => movies.media(name, args)),
    run: (name, args) => client((movies) => movies.run(name, args)),
    subscribe: (name, args, onValue, onError) =>
      listen(
        Stream.unwrap(Effect.map(MoviesClient, (movies) => movies.subscribe(name, args))),
        onValue,
        onError,
      ),
    auth: {
      status: () => auth((session) => session.currentStatus),
      onStatus: (listener) =>
        listen(
          Stream.unwrap(Effect.map(Auth.Auth, (session) => session.status)),
          listener,
          () => undefined,
        ),
      signInWithPassword: (credentials) =>
        auth((session) => session.signIn(Auth.passwordCredentials(credentials))),
      signInWithApiKey: (key) =>
        auth((session) => session.signIn(Auth.Credentials.ApiKey({ key: Redacted.make(key) }))),
      startDeviceLogin: (clientName) => DeviceLogin.startOn(runtime, clientName),
      signOut: () => auth((session) => session.signOut),
    },
    playback: {
      start: (request) => runtime.runPromise(Playback.start(request)),
      reportProgress: async (playback, player) =>
        (await scoped(Playback.reportProgress(playback, player))).stop,
    },
    rooms: {
      sync: async (roomId, deviceId, player, tunables = DEFAULT_TUNABLES) => {
        const { value, stop } = await scoped(RoomSync.run({ roomId, deviceId, player, tunables }));

        return {
          current: () => Effect.runPromise(value.current),
          subscribe: (listener) => listen(value.state, listener, () => undefined),
          stop,
        };
      },
    },
    dispose: async () => {
      await Effect.runPromise(Scope.close(workflows, Exit.void));
      await runtime.dispose();
    },
  };
};
