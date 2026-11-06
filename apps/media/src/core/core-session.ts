import { Platform, TokenStorage } from "@media/sdk/effect";
import { Context, Effect, Layer, type Redacted, Ref, Schedule, Semaphore } from "effect";

/**
 * `signed-in` once the core accepted the server's key; `signed-out` while it signs in, and after
 * the core refused the key.
 */
export type Status = "signed-in" | "signed-out";

/** The server signed in to the core as its service principal (ADR 0010). */
export interface Interface {
  readonly status: Effect.Effect<Status>;
  /**
   * Runs `call` with the core's client as the service. When the core answers that the session
   * ended, signs in once more with the key and runs `call` again; a key the core refuses then
   * fails the call with `Unauthenticated`.
   */
  readonly run: <A>(
    call: (platform: Platform.Interface) => Effect.Effect<A, Platform.PlatformError>,
  ) => Effect.Effect<A, Platform.PlatformError>;
}

export class Service extends Context.Service<Service, Interface>()("@media/server/CoreSession") {}

/** Where the core is and the key it issued this server (`core/auth/apiKeys:issueServiceKey`). */
export interface Options {
  readonly convexUrl: string;
  readonly apiKey: Redacted.Redacted;
}

const backoff = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

const make = Effect.fn("CoreSession.make")(function* (options: Options) {
  const platform = yield* Platform.Platform;
  const signedIn = yield* Ref.make(false);
  const generation = yield* Ref.make(0);
  const signingIn = yield* Semaphore.make(1);

  const attempt = platform.session
    .signIn(Platform.Credentials.ApiKey({ key: options.apiKey }))
    .pipe(
      Effect.catchTag("TokenStorageError", Effect.die),
      Effect.tapError((error) => Effect.logWarning("CoreSession.sign_in_failed", error)),
    );

  const signIn = (seen: number) =>
    signingIn.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== seen) return;
        yield* Ref.set(signedIn, false);
        yield* attempt;
        yield* Ref.update(generation, (current) => current + 1);
        yield* Ref.set(signedIn, true);
        yield* Effect.logInfo("CoreSession.signed_in");
      }),
    );

  yield* Effect.forkScoped(signIn(0).pipe(Effect.retry(backoff)));

  const run: Interface["run"] = Effect.fn("CoreSession.run")(function* <A>(
    call: (client: Platform.Interface) => Effect.Effect<A, Platform.PlatformError>,
  ) {
    const seen = yield* Ref.get(generation);

    return yield* call(platform).pipe(
      Effect.catchTag("Unauthenticated", () => signIn(seen).pipe(Effect.andThen(call(platform)))),
    );
  });

  return Service.of({
    status: Effect.map(Ref.get(signedIn), (held) => (held ? "signed-in" : "signed-out")),
    run,
  });
});

/**
 * Signs the server in to the core at `options.convexUrl` with its key, over a connection of its
 * own, and keeps trying with backoff until the core accepts it. Fails only when the URL is not
 * valid.
 */
export const layer = (options: Options): Layer.Layer<Service, Platform.OpenError> =>
  Layer.effect(Service, make(options)).pipe(
    Layer.provide(
      Platform.layer({
        url: options.convexUrl,
        connection: "websocket",
        storage: TokenStorage.layerMemory,
      }),
    ),
  );
