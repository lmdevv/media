import { mediaServiceFunctions } from "@movies/contracts/media-service";
import type { MediaServiceFunctions } from "@movies/contracts/media-service";
import { InvalidArgs } from "@movies/contracts/errors";
import {
  Auth,
  ConvexTransport,
  ProtocolError,
  TokenStorage,
  TransportError,
} from "@movies/sdk/effect";
import type { CallError } from "@movies/sdk/effect";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  type Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import * as BackendHealth from "../backend-health.ts";

/** A media service function by its registry name, such as `mediaService.claimJob`. */
export type FunctionName = keyof MediaServiceFunctions;

/** Media service functions served by a Convex query; only these can be subscribed to. */
export type QueryName = {
  readonly [Name in FunctionName]: MediaServiceFunctions[Name]["kind"] extends "query"
    ? Name
    : never;
}[FunctionName];

/** Decoded arguments of a media service function. */
export type FunctionArgs<Name extends FunctionName> = MediaServiceFunctions[Name]["args"]["Type"];

/** Decoded result of a media service function. */
export type FunctionResult<Name extends FunctionName> =
  MediaServiceFunctions[Name]["result"]["Type"];

/** Calls the media service functions as the service account. */
export interface Interface {
  /** Runs a function once; waits up to fifteen seconds for the first sign-in. */
  readonly call: <Name extends FunctionName>(
    name: Name,
    args: FunctionArgs<Name>,
  ) => Effect.Effect<FunctionResult<Name>, CallError>;
  /**
   * The query's result now and after every change. A dropped subscription is resumed with
   * backoff, so the stream never ends on its own.
   */
  readonly subscribe: <Name extends QueryName>(
    name: Name,
    args: FunctionArgs<Name>,
  ) => Stream.Stream<FunctionResult<Name>>;
  /**
   * `connected` while the service account is signed in and Convex answered its latest probe;
   * `connecting` while it signs in, or once a probe goes unanswered until one is answered again.
   */
  readonly status: Effect.Effect<"connected" | "connecting">;
}

/** The Convex connection. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MediaBackend") {}

/** Where to connect and as whom. */
export interface Options {
  readonly convexUrl: string;
  readonly apiKey: Redacted.Redacted;
  /** Longest one call may wait for its answer; 30 seconds when absent. */
  readonly callTimeout?: Duration.Duration;
  /**
   * How often the service asks Convex something to learn whether it still answers; 30 seconds
   * when absent. A question that gets no answer signs the service in again.
   */
  readonly probeEvery?: Duration.Duration;
}

const READY_WAIT = Duration.seconds(15);

/**
 * Longest one call may wait for its answer. The WebSocket transport queues calls while it
 * reconnects; without a bound, a call made during an outage waits for as long as the outage lasts.
 * A timed-out mutation may still apply later, as any lost answer may, so callers retry only
 * idempotent work.
 */
const DEFAULT_CALL_TIMEOUT = Duration.seconds(30);

const DEFAULT_PROBE_EVERY = Duration.seconds(30);

const backoff = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

const decodeWireArgs = Schema.decodeUnknownEffect(Schema.JsonObject);

const encodeArgs = <Name extends FunctionName>(name: Name, args: FunctionArgs<Name>) =>
  Schema.encodeUnknownEffect(mediaServiceFunctions[name].args)(args).pipe(
    Effect.flatMap(decodeWireArgs),
    Effect.mapError(
      (error) => new InvalidArgs({ message: `Invalid arguments for ${name}: ${error.message}` }),
    ),
  );

const decodeResult = <Name extends FunctionName>(
  name: Name,
  raw: Schema.Json,
): Effect.Effect<FunctionResult<Name>, ProtocolError> =>
  Schema.decodeUnknownEffect(mediaServiceFunctions[name].result)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation: name,
          message: `Protocol error in ${name}: the result does not match the contract`,
          cause,
        }),
    ),
  );

const make = Effect.fn("MediaBackend.make")(function* (options: Options) {
  const sdk = yield* Layer.build(
    Auth.layer({ convexUrl: options.convexUrl }).pipe(
      Layer.provideMerge(ConvexTransport.layerWebSocket(options.convexUrl)),
      Layer.provide(TokenStorage.layerMemory),
    ),
  );

  const transport = Context.get(sdk, ConvexTransport.ConvexTransport);
  const auth = Context.get(sdk, Auth.Auth);
  const ready = yield* Deferred.make<void>();
  const signedIn = yield* Ref.make(false);
  const generation = yield* Ref.make(0);
  const signingIn = yield* Semaphore.make(1);
  const attempts = yield* Ref.make(0);
  const callTimeout = options.callTimeout ?? DEFAULT_CALL_TIMEOUT;
  const probeEvery = options.probeEvery ?? DEFAULT_PROBE_EVERY;
  const answeredAt = yield* Ref.make(Option.none<number>());

  const staleAfter = Duration.sum(probeEvery, callTimeout);

  const signInOnce = auth
    .signIn(Auth.Credentials.ApiKey({ key: options.apiKey }))
    .pipe(
      Effect.tapError((error) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            Effect.logWarning("MediaBackend.sign_in_failed", error).pipe(
              Effect.annotateLogs({ attempt }),
            ),
          ),
        ),
      ),
    );

  const signIn = (seen: number) =>
    signingIn.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== seen) return;
        yield* Ref.set(signedIn, false);
        yield* signInOnce.pipe(Effect.retry(backoff), Effect.orDie);
        yield* Ref.set(attempts, 0);
        yield* Ref.update(generation, (current) => current + 1);
        yield* Ref.set(signedIn, true);
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.logInfo("MediaBackend.signed_in");
      }),
    );

  yield* Effect.forkScoped(signIn(0));

  const awaitReady = Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: READY_WAIT,
      orElse: () =>
        Effect.fail(
          new TransportError({
            operation: "MediaBackend.signIn",
            message: "Transport failed: the media service has not signed in to Convex yet",
            cause: null,
          }),
        ),
    }),
  );

  const callOnce = <Name extends FunctionName>(name: Name, wire: Schema.JsonObject) =>
    transport
      .call(mediaServiceFunctions[name].kind, mediaServiceFunctions[name].function, wire)
      .pipe(
        Effect.timeoutOrElse({
          duration: callTimeout,
          orElse: () =>
            Effect.fail(
              new TransportError({
                operation: name,
                message: `Transport failed: ${name} did not answer within ${String(Duration.toSeconds(callTimeout))} seconds`,
                cause: null,
              }),
            ),
        }),
        Effect.flatMap((raw) => decodeResult(name, raw)),
      );

  const call = <Name extends FunctionName>(
    name: Name,
    args: FunctionArgs<Name>,
  ): Effect.Effect<FunctionResult<Name>, CallError> =>
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, args);
      yield* awaitReady;
      const seen = yield* Ref.get(generation);

      return yield* callOnce(name, wire).pipe(
        Effect.catchTag("Unauthenticated", () =>
          signIn(seen).pipe(Effect.andThen(callOnce(name, wire))),
        ),
      );
    }).pipe(Effect.withSpan("MediaBackend.call", { attributes: { function: name } }));

  const subscribe = <Name extends QueryName>(
    name: Name,
    args: FunctionArgs<Name>,
  ): Stream.Stream<FunctionResult<Name>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const wire = yield* encodeArgs(name, args).pipe(Effect.orDie);
        yield* Deferred.await(ready);

        return transport
          .subscribe(mediaServiceFunctions[name].function, wire)
          .pipe(Stream.mapEffect((raw) => decodeResult(name, raw)));
      }),
    ).pipe(
      Stream.tapError((error) =>
        Effect.logWarning("MediaBackend.subscription_failed", error).pipe(
          Effect.annotateLogs({ function: name }),
          Effect.andThen(
            Predicate.isTagged(error, "Unauthenticated")
              ? Ref.get(generation).pipe(Effect.flatMap(signIn))
              : Effect.void,
          ),
        ),
      ),
      Stream.retry(backoff),
      Stream.orDie,
    );

  const markAnswered = Clock.currentTimeMillis.pipe(
    Effect.flatMap((at) => Ref.set(answeredAt, Option.some(at))),
  );

  const ask = (probeId: string) =>
    call("mediaService.sessionStatus", { sessionId: probeId }).pipe(
      // Any other failure is Convex answering: the connection works, the function does not.
      Effect.tapError((error) =>
        Predicate.isTagged(error, "TransportError") || Predicate.isTagged(error, "Unauthenticated")
          ? Effect.void
          : markAnswered,
      ),
      Effect.andThen(markAnswered),
    );

  /**
   * Asks Convex something it must answer itself: the session it asks about is new for each probe,
   * so the client cannot answer from a subscription's cache. A connection can stop answering while it looks
   * connected, as when the Convex client holds a token Convex no longer accepts and never asks
   * for another, so an unanswered probe signs in again, which hands the client a fresh token and
   * resets its auth state. During a Convex outage that sign-in waits, retrying, until Convex is
   * back. The connection may still be waiting out its own reconnect backoff then, so the probe
   * keeps asking, each ask waiting up to `callTimeout` and the next starting a second later, until
   * Convex answers or the next probe is due. An ask that times out drops its query from the
   * client, so a long outage leaves no backlog of probes to send once Convex is back.
   */
  const probe = Effect.gen(function* () {
    const seen = yield* Ref.get(generation);
    const probeId = `probe-${String(yield* Clock.currentTimeMillis)}`;

    yield* ask(probeId).pipe(
      Effect.catchTag("TransportError", (error) =>
        Effect.logWarning("MediaBackend.unanswered", error).pipe(
          Effect.andThen(Ref.set(answeredAt, Option.none())),
          Effect.andThen(signIn(seen)),
          Effect.andThen(
            ask(probeId).pipe(
              Effect.retry({
                while: (failure) => Predicate.isTagged(failure, "TransportError"),
                schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: probeEvery })),
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.catch((error) => Effect.logWarning("MediaBackend.probe_failed", error)));

  yield* Deferred.await(ready).pipe(
    Effect.andThen(probe.pipe(Effect.repeat(Schedule.spaced(probeEvery)))),
    Effect.forkScoped,
  );

  const status = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(answeredAt);
    const fresh = Option.exists(last, (at) => now - at < Duration.toMillis(staleAfter));

    return (yield* Ref.get(signedIn)) && fresh ? ("connected" as const) : ("connecting" as const);
  });

  return Service.of({ call, subscribe, status });
});

/**
 * The connection as a layer, which also reports its state to `GET /api/health`. Fails only when
 * the Convex URL is not valid.
 */
export const layer = (
  options: Options,
): Layer.Layer<Service | BackendHealth.Service, TransportError | TokenStorage.TokenStorageError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const backend = yield* make(options);

      return Context.make(Service, backend).pipe(
        Context.add(BackendHealth.Service, BackendHealth.Service.of({ status: backend.status })),
      );
    }),
  );
