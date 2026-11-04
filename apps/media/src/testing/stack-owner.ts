import type { JobId } from "@media/contracts/ids";
import type { Job } from "@media/contracts/models/jobs";
import { Auth, ConvexTransport, Movies, MoviesClient, TokenStorage } from "@media/sdk/effect";
import type { TransportError } from "@media/sdk/effect";
import type { Context, Duration, Scope } from "effect";
import { Effect, Layer, Option, Redacted, Stream } from "effect";

/** The password of every stack test account. A test value only. */
export const STACK_PASSWORD = "stack-test-password";

/** The owner accounts the stack suites share; the first signs up on an empty backend. */
export const OWNER_EMAILS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

/** A signed-in SDK session. */
export type StackSession = Context.Context<Movies.Services | ConvexTransport.ConvexTransport>;

/** Opens an SDK session over WebSockets that lives as long as `scope`. */
export const openSession = (
  convexUrl: string,
  mediaUrl: string,
  scope: Scope.Scope,
): Effect.Effect<StackSession, TokenStorage.TokenStorageError | TransportError> =>
  Layer.buildWithScope(
    Movies.layerWithTransport({ convexUrl, mediaUrl: Option.some(mediaUrl) }).pipe(
      Layer.provideMerge(ConvexTransport.layerWebSocket(convexUrl)),
      Layer.provide(TokenStorage.layerMemory),
    ),
    scope,
  );

/** Runs `effect` in `session`. */
export const runIn = <A, E>(
  session: StackSession,
  effect: Effect.Effect<A, E, Movies.Services | ConvexTransport.ConvexTransport>,
): Promise<A> => Effect.runPromise(Effect.provideContext(effect, session));

/** The session's command client. */
export const client = Effect.map(MoviesClient.MoviesClient, (service) => service);

const password = (email: string, flow: "signIn" | "signUp") =>
  Auth.Credentials.Password({
    flow,
    email,
    password: Redacted.make(STACK_PASSWORD),
    name: Option.none(),
    inviteCode: Option.none(),
  });

/** Signs in as the stack's owner, creating it on an empty backend; returns the owner's email. */
export const signInOwner = Effect.gen(function* () {
  const auth = yield* Auth.Auth;
  const status = yield* (yield* client).query("setup.status", {});

  if (!status.hasOwner) {
    yield* auth.signIn(password(OWNER_EMAILS[0], "signUp"));

    return OWNER_EMAILS[0];
  }

  for (const email of OWNER_EMAILS) {
    const signedIn = yield* auth.signIn(password(email, "signIn")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

    if (signedIn) return email;
  }

  return yield* Effect.die(new Error("The backend has an owner from elsewhere; use a fresh stack"));
});

/** Waits until a job finishes and returns it. */
export const finished = (jobId: JobId, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const movies = yield* client;

    return yield* movies.subscribe("jobs.get", { jobId }).pipe(
      Stream.filter((job: Job) => job.status !== "pending" && job.status !== "running"),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
      Effect.timeout(timeout),
    );
  });
