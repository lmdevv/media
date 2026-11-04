import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

import { DeviceId, ProfileId } from "@media/contracts/ids";
import { Auth, MediaOrigin, Movies, MoviesClient, TokenStorage } from "@media/sdk/effect";
import type { CallError } from "@media/sdk/effect";
import { Context, Effect, Layer, Option } from "effect";

import { ConfigFileError, NotLoggedIn } from "./cli-errors";
import type { Environment, Target } from "./config";
import { layerProfileStorage } from "./config";

/** What a signed-in command works with. */
export interface Connection {
  readonly client: MoviesClient.Interface;
  readonly target: Target;
  readonly convexUrl: string;
  /** This install's device on this server. */
  readonly deviceId: DeviceId;
  /** The default viewing profile from `media profiles use` or login. */
  readonly viewingProfileId: Option.Option<ProfileId>;
  /**
   * Runs a call, signing in again with the API key once if the server ended the session. Its
   * playback requests go to the configured media URL, when there is one (`MediaOrigin`).
   */
  readonly withSession: <A>(
    effect: Effect.Effect<A, MoviesClient.ClientError>,
  ) => Effect.Effect<A, CallError | ConfigFileError>;
}

const derivedDeviceId = (convexUrl: string): DeviceId =>
  DeviceId.make(
    `cli-${createHash("sha256")
      .update(`${hostname()}\u0000${userInfo().username}\u0000${convexUrl}`)
      .digest("hex")
      .slice(0, 24)}`,
  );

/** This install's device on the target's server: the stored one, or one derived from the host. */
export const deviceIdFor = (target: Target): DeviceId =>
  Option.match(target.stored, {
    onNone: () => derivedDeviceId(Option.getOrElse(target.convexUrl, () => "")),
    onSome: (profile) => DeviceId.make(profile.deviceId),
  });

/** Token store failures surface as config file errors: that is where the tokens live. */
export const storageFailure = (path: string) => (error: TokenStorage.TokenStorageError) =>
  new ConfigFileError({ path, message: error.message, cause: error });

/** Opens the SDK for `convexUrl` with the given token store. */
export const openSdk = (
  convexUrl: string,
  mediaUrl: Option.Option<string>,
  storage: Layer.Layer<TokenStorage.TokenStorage>,
  configPath: string,
) =>
  Layer.build(
    Movies.layer({ convexUrl, mediaUrl, connection: "http" }).pipe(Layer.provide(storage)),
  ).pipe(
    Effect.map((context) => ({
      client: Context.get(context, MoviesClient.MoviesClient),
      auth: Context.get(context, Auth.Auth),
    })),
    Effect.catchTag("TokenStorageError", (error) => Effect.fail(storageFailure(configPath)(error))),
  );

/**
 * Connects to the target's server. `required` fails with `NotLoggedIn` when no session can be
 * opened; `optional` connects anonymously for public commands.
 */
export const connect = Effect.fn("Session.connect")(function* (
  env: Environment,
  target: Target,
  mode: "required" | "optional",
) {
  if (Option.isNone(target.convexUrl)) {
    return yield* new NotLoggedIn({
      message:
        "Not logged in: run media login --server <convex-url>, or set MEDIA_CONVEX_URL and MEDIA_API_KEY",
    });
  }

  const convexUrl = target.convexUrl.value;

  const storage =
    target.sessionStorage === "profile"
      ? layerProfileStorage(env.configPath, target.name, Option.none())
      : TokenStorage.layerMemory;

  const { client, auth } = yield* openSdk(convexUrl, target.mediaUrl, storage, env.configPath);

  const signInWithKey = Option.match(target.apiKey, {
    onNone: () => Effect.succeed(false),
    onSome: (key) =>
      auth.signIn(Auth.Credentials.ApiKey({ key })).pipe(
        Effect.as(true),
        Effect.catchTag("TokenStorageError", (error) =>
          Effect.fail(storageFailure(env.configPath)(error)),
        ),
      ),
  });

  if ((yield* auth.currentStatus) !== "signedIn") yield* signInWithKey;

  if (mode === "required" && (yield* auth.currentStatus) !== "signedIn") {
    return yield* new NotLoggedIn({
      message: `Not logged in to ${convexUrl}: run media login`,
    });
  }

  const stored = target.stored;

  const withSession = <A>(
    effect: Effect.Effect<A, MoviesClient.ClientError>,
  ): Effect.Effect<A, CallError | ConfigFileError> => {
    const attempt = effect.pipe(
      Effect.provideService(MediaOrigin, target.mediaUrl),
      Effect.catchTag("TokenStorageError", (error) =>
        Effect.fail(storageFailure(env.configPath)(error)),
      ),
    );

    return attempt.pipe(
      Effect.catchTag("Unauthenticated", (error) =>
        Option.isSome(target.apiKey) ? Effect.andThen(signInWithKey, attempt) : Effect.fail(error),
      ),
    );
  };

  const connection: Connection = {
    client,
    target,
    convexUrl,
    deviceId: deviceIdFor(target),
    viewingProfileId: Option.flatMap(stored, (profile) =>
      Option.fromNullishOr(profile.viewingProfileId),
    ).pipe(Option.map((value) => ProfileId.make(value))),
    withSession,
  };

  return connection;
});
