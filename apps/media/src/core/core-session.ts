import { Platform, TokenStorage } from "@media/sdk/effect";
import {
  Context,
  Effect,
  Layer,
  Predicate,
  Queue,
  type Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

/**
 * `signed-in` once the core accepted the server's key; `signed-out` while it signs in, and after
 * the core refused the key. The server learns that the core ended its session only from a call,
 * so the status is as of the latest sign-in or call.
 */
export type Status = "signed-in" | "signed-out";

/** The server signed in to the core as its service principal (ADR 0010). */
export interface Interface {
  readonly status: Effect.Effect<Status>;
  /**
   * Runs `call` with the core's client as the service. When the core answers that the session
   * ended, signs in once more with the key and runs `call` again. A key the core refuses then
   * fails the call with `Unauthenticated`, and signing in goes on in the background with backoff.
   */
  readonly run: <A>(
    call: (platform: Platform.Interface) => Effect.Effect<A, Platform.PlatformError>,
  ) => Effect.Effect<A, Platform.PlatformError>;
  /** Runs one of the core's server functions once, signing in again as `run` does. */
  readonly call: <Kind extends "query" | "mutation", Args, Result>(
    fn: Platform.Command<Kind, Args, Result>,
    ...params: Platform.Params<Args>
  ) => Effect.Effect<Result, Platform.PlatformError>;
  /**
   * A server query's result now and after every change. A dropped or refused subscription
   * subscribes again with backoff, signing in again first when the core ended the session, so
   * the stream never ends on its own.
   */
  readonly watch: <Args, Result>(
    fn: Platform.Command<"query", Args, Result>,
    ...params: Platform.Params<Args>
  ) => Stream.Stream<Result>;
}

export class Service extends Context.Service<Service, Interface>()("@media/server/CoreSession") {}

/** A server query's subscription ended without failing; the watch subscribes again. */
class WatchEnded extends Schema.TaggedError<WatchEnded>()("WatchEnded", {
  function: Schema.String,
}) {}

/** The core's client and the one way the server signs in to it. */
export interface ConnectionInterface {
  /** Signs in with the server's key, replacing any session the client held. */
  readonly signIn: Effect.Effect<void, Platform.PlatformError>;
  /** The core's commands as methods, for `run`. */
  readonly platform: Effect.Effect<Platform.Interface>;
  readonly client: Pick<Platform.ClientInterface, "run" | "watch">;
}

/** The connection `layerFrom` signs in over; `layer` provides the real one. */
export class Connection extends Context.Service<Connection, ConnectionInterface>()(
  "@media/server/CoreSession/Connection",
) {}

/** Where the core is and the key it issued this server (`core/auth/apiKeys:issueServiceKey`). */
export interface Options {
  readonly convexUrl: string;
  readonly apiKey: Redacted.Redacted;
}

const backoff = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

const make = Effect.gen(function* () {
  const connection = yield* Connection;
  const { platform, client } = connection;
  const signedIn = yield* Ref.make(false);
  const generation = yield* Ref.make(0);
  const signingIn = yield* Semaphore.make(1);

  const attempt = connection.signIn.pipe(
    Effect.tapError((error) => Effect.logWarning("CoreSession.sign_in_failed", error)),
  );

  const signedInNow = Effect.gen(function* () {
    yield* attempt;
    yield* Ref.update(generation, (current) => current + 1);
    yield* Ref.set(signedIn, true);
    yield* Effect.logInfo("CoreSession.signed_in");
  });

  /** Signs in again unless someone already did since `seen`, when the session was found ended. */
  const signIn = (seen: number) =>
    signingIn.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== seen) return;
        yield* Ref.set(signedIn, false);
        yield* signedInNow;
      }),
    );

  /** Signs in if no session holds now; reads the state again on every retry. */
  const ensureSignedIn = signingIn.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Ref.get(signedIn)) return;
      yield* signedInNow;
    }),
  );

  // One loop keeps signing in. A wake-up while it retries coalesces into the queue's one slot, so
  // the loop runs again after it finishes and no request to sign in is ever dropped. It never
  // carries the generation it started from: a retry from before a sign-in cannot mistake a later
  // refusal for that sign-in and stop, leaving the server signed out.
  const wake = yield* Queue.sliding<void>(1);

  yield* Stream.fromQueue(wake).pipe(
    Stream.runForEach(() => ensureSignedIn.pipe(Effect.retry(backoff))),
    Effect.forkScoped,
  );

  const keepSigningIn = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  yield* keepSigningIn;

  const signInAgain = (seen: number) => signIn(seen).pipe(Effect.tapError(() => keepSigningIn));

  const withSession = <A>(
    call: Effect.Effect<A, Platform.PlatformError>,
  ): Effect.Effect<A, Platform.PlatformError> =>
    Effect.flatMap(Ref.get(generation), (seen) =>
      call.pipe(
        Effect.catchTag("Unauthenticated", () => signInAgain(seen).pipe(Effect.andThen(call))),
      ),
    );

  const watch: Interface["watch"] = (fn, ...params) =>
    Stream.unwrap(
      Effect.map(Ref.get(generation), (seen) =>
        client.watch(fn, params).pipe(
          // A subscription that ends without failing resubscribes too: a watch never ends.
          Stream.concat(Stream.fail(new WatchEnded({ function: fn.name }))),
          Stream.tapError((error) =>
            Predicate.isTagged(error, "Unauthenticated")
              ? signInAgain(seen).pipe(Effect.ignore)
              : Effect.logWarning("CoreSession.watch_failed", error).pipe(
                  Effect.annotateLogs({ function: fn.name }),
                ),
          ),
        ),
      ),
      // The backoff never ends, so no error passes it.
    ).pipe(Stream.retry(backoff), Stream.orDie);

  return Service.of({
    status: Effect.map(Ref.get(signedIn), (held) => (held ? "signed-in" : "signed-out")),
    run: (call) => withSession(Effect.flatMap(platform, call)),
    call: (fn, ...params) => withSession(client.run(fn, params)),
    watch,
  });
});

/** The session over a `Connection`, signing in at once and keeping at it until the core accepts. */
export const layerFrom: Layer.Layer<Service, never, Connection> = Layer.effect(Service, make);

const connect = Effect.fn("CoreSession.connect")(function* (options: Options) {
  const client = yield* Platform.Client;

  return Connection.of({
    signIn: client.session
      .signIn(Platform.Credentials.ApiKey({ key: options.apiKey }))
      .pipe(Effect.catchTag("TokenStorageError", Effect.die)),
    platform: Effect.succeed({ ...client.methods, session: client.session }),
    client,
  });
});

/**
 * Signs the server in to the core at `options.convexUrl` with its key, over a connection of its
 * own, and keeps trying with backoff until the core accepts it. Fails only when the URL is not
 * valid.
 */
export const layer = (options: Options): Layer.Layer<Service, Platform.OpenError> =>
  layerFrom.pipe(
    Layer.provide(Layer.effect(Connection, connect(options))),
    Layer.provide(
      Platform.layerClient({
        url: options.convexUrl,
        connection: "websocket",
        storage: TokenStorage.layerMemory,
      }),
    ),
  );
