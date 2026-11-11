import {
  loadPassKeys,
  PASS_PARAM,
  SERVER_ADDRESS,
  signInProviders,
} from "@media/contracts/sign-in";
import type { PassKeys, SignInProvider } from "@media/contracts/sign-in";
import type { Auth } from "@media/sdk/effect";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";

/** A sign-in as the boundary takes it and the core's `auth:signIn` does: a provider and params. */
export const SignInBody = Schema.Struct({
  provider: Schema.Literals(signInProviders),
  params: Schema.Record(Schema.String, Schema.Json),
});

const decodeSignIn = Schema.decodeUnknownEffect(SignInBody);

/** `MEDIA_TICKET_KEYS` does not hold a ring the pass keys derive from. */
export class PassKeysUnusable extends Schema.TaggedError<PassKeysUnusable>()("PassKeysUnusable", {
  problem: Schema.String,
}) {
  override get message(): string {
    return `MEDIA_TICKET_KEYS is not usable for sign-in passes: ${this.problem}`;
  }
}

/**
 * Signs the passes the core takes sign-ins with (ADR 0007), from keys derived from
 * `MEDIA_TICKET_KEYS`. Only the sign-in boundary and the server's own sign-in use it.
 */
export class Passes extends Context.Service<
  Passes,
  {
    /**
     * A pass for one sign-in with `provider` and `params`, less any pass they hold, from
     * `address`. The params the core gets are `params` with the pass at `PASS_PARAM`.
     */
    readonly pass: (
      provider: SignInProvider,
      params: Readonly<Record<string, Schema.Json>>,
      address: string,
    ) => Effect.Effect<string>;
  }
>()("@media/server/SignInPasses") {}

const passesWith = (keys: PassKeys) =>
  Passes.of({
    pass: (provider, params, address) =>
      Effect.gen(function* () {
        const { [PASS_PARAM]: _sent, ...own } = params;
        const now = yield* Clock.currentTimeMillis;

        return yield* Effect.promise(() => keys.sign({ provider, params: own, address, now }));
      }),
  });

/** Passes signed with the ring `ticketKeys`; fails when the ring is not usable. */
export const layer = (ticketKeys: Redacted.Redacted): Layer.Layer<Passes, PassKeysUnusable> =>
  Layer.effect(
    Passes,
    Effect.gen(function* () {
      const loaded = yield* Effect.promise(() => loadPassKeys(Redacted.value(ticketKeys)));

      if (!loaded.ok) return yield* new PassKeysUnusable({ problem: loaded.error.problem });

      return passesWith(loaded.value);
    }),
  );

/**
 * The server's own sign-in with its service key. The server is the boundary, so it passes the
 * sign-in itself, for `SERVER_ADDRESS`, and calls `auth:signIn` straight away.
 */
export const ownSignIn =
  (passes: Passes["Service"]) =>
  (request: Auth.SignInRequest): Effect.Effect<Auth.SignInRequest> =>
    Effect.gen(function* () {
      // The server builds its own sign-in, so params that are not JSON are a bug in it.
      const { provider, params } = yield* decodeSignIn(request).pipe(Effect.orDie);
      const pass = yield* passes.pass(provider, params, SERVER_ADDRESS);

      return { provider, params: { ...request.params, [PASS_PARAM]: pass } };
    });
