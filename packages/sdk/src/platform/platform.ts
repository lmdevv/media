import { Context, Effect, Layer } from "effect";

import * as Client from "./client";

/** The platform's commands as Effect methods, and the session. */
export interface Interface extends Client.EffectMethods {
  readonly session: Client.Session;
}

/** The platform client, for Effect programs. */
export class Platform extends Context.Service<Platform, Interface>()("@media/sdk/Platform") {}

/**
 * The platform at `options.url`, over its own connection and session, so it runs beside the
 * movies client without sharing either.
 */
export const layer = (options: Client.Options): Layer.Layer<Platform, Client.OpenError> =>
  Layer.effect(
    Platform,
    Effect.map(Client.Client, (client) =>
      Platform.of({ ...client.methods, session: client.session }),
    ),
  ).pipe(Layer.provide(Client.layer(options)));

export { Credentials, DeviceSignInRefused, TileProof } from "./client";

export type { DeviceSignIn, OpenError, Options, Session } from "./client";

export type { Id, PlatformError } from "./command";
