import type { AuthTokenFetcher } from "convex/browser";
import { ConvexError } from "convex/values";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Scope,
  Stream,
  Struct,
} from "effect";
import { describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as ConvexTransport from "./convex-transport";
import { clientTokenFetchers, translateFailure } from "./convex-transport";
import * as MoviesClient from "./movies-client";
import * as FakeConvex from "./testing/fake-convex";
import { issuedOf, jwtIssuedAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";

/** Long enough for the client's ten-second refresh leeway, short enough to outlive in a test. */
const TOKEN_LIFETIME_SECONDS = 12;

const mintToken = (): Reply =>
  Reply.Success({
    value: {
      tokens: {
        token: jwtIssuedAt(Date.now(), TOKEN_LIFETIME_SECONDS, "service|session"),
        refreshToken: "refresh",
      },
    },
  });

const askAfterFirstTokenExpires = (signIn: (request: { readonly args: unknown }) => Reply) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        yield* fake.handle("auth:signIn", (request) => Effect.sync(() => signIn(request)));
        yield* fake.reply("account:viewer", Reply.Success({ value: "signed in" }));

        const context = yield* Layer.build(
          Auth.layer({ convexUrl: fake.url }).pipe(
            Layer.provideMerge(ConvexTransport.layerWebSocket(fake.url)),
            Layer.provide(TokenStorage.layerMemory),
          ),
        );

        const auth = Context.get(context, Auth.Auth);
        const transport = Context.get(context, ConvexTransport.ConvexTransport);
        const viewer = transport.call("query", "account:viewer", {});

        // Start at the top of a second, so the sign-in and the client's first refresh share it.
        yield* Effect.sleep(Duration.millis(1000 - (Date.now() % 1000)));
        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("mk_service") }));
        const signedInAt = Date.now();

        expect(yield* viewer).toBe("signed in");

        yield* Effect.sleep(
          Duration.millis(signedInAt + (TOKEN_LIFETIME_SECONDS + 1) * 1000 - Date.now()),
        );

        const later = yield* viewer.pipe(Effect.timeout(Duration.seconds(5)));

        expect(new Set(yield* fake.acceptedTokens).size).toBeGreaterThan(1);

        return later;
      }),
    ),
  );

/**
 * How often a source that keeps handing back its token was asked before and after `stop` ends
 * the connection's use of it. That token makes the connection ask again, waiting longer each
 * time; stopped, it must not ask any more.
 */
const asksAround = (
  stop: (connection: ConvexTransport.Interface, scope: Scope.Closeable) => Effect.Effect<void>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;
        const scope = yield* Scope.make();

        const context = yield* Layer.buildWithScope(
          ConvexTransport.layerWebSocket(fake.url),
          scope,
        );

        const connection = Context.get(context, ConvexTransport.ConvexTransport);
        const token = jwtIssuedAt(Date.now(), 3600, "user|session");
        let asked = 0;

        yield* connection.setAuth(() => {
          asked += 1;

          return Promise.resolve(issuedOf(token));
        });
        yield* Effect.sync(() => asked).pipe(
          Effect.repeat({ until: (count) => count >= 2, schedule: Schedule.spaced("50 millis") }),
          Effect.timeout(Duration.seconds(5)),
        );
        yield* stop(connection, scope);
        const stopped = asked;

        // Long enough for two more asks at the first waits, one and two seconds.
        yield* Effect.sleep(Duration.seconds(3.5));

        return { stopped, later: asked };
      }),
    ),
  );

describe.concurrent("layerWebSocket", () => {
  it("keeps a session working when a refresh in its sign-in second mints the same token", async () => {
    // Convex Auth signs to the second, so that refresh returns the sign-in's very token.
    expect(await askAfterFirstTokenExpires(mintToken)).toBe("signed in");
  }, 30_000);

  it("keeps a session working when refreshing fails for a while", async () => {
    let failingUntil = Number.POSITIVE_INFINITY;

    const answer = await askAfterFirstTokenExpires(({ args }) => {
      if (!Predicate.hasProperty(args, "refreshToken")) {
        failingUntil = Date.now() + 4000;

        return mintToken();
      }

      return Date.now() < failingUntil ? Reply.Crash({ message: "Convex is busy" }) : mintToken();
    });

    expect(answer).toBe("signed in");
  }, 30_000);

  it("stops asking for a token once signed out", async () => {
    const { stopped, later } = await asksAround((connection) => connection.setAuth(null));

    expect(later).toBe(stopped);
  }, 15_000);

  it("comes back when a new token source arrives while Convex waits to reauthenticate", async () => {
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          yield* fake.reply("account:viewer", Reply.Success({ value: "signed in" }));
          const context = yield* Layer.build(ConvexTransport.layerWebSocket(fake.url));
          const connection = Context.get(context, ConvexTransport.ConvexTransport);
          const signedIn = jwtIssuedAt(Date.now(), 3600, "user|session-1");
          const refreshed = jwtIssuedAt(Date.now(), 3600, "user|session-1-refreshed");
          let asked = 0;

          // The first refresh works; later ones keep failing, handing back the token they have.
          yield* connection.setAuth(() => {
            asked += 1;

            return Promise.resolve(issuedOf(asked === 1 ? signedIn : refreshed));
          });
          yield* connection.call("query", "account:viewer", { ask: 1 });
          yield* Effect.sleep(Duration.millis(300));

          // Convex stops the socket and asks for a new token, which does not come.
          yield* fake.rejectAcceptedTokens;
          yield* Effect.sleep(Duration.millis(300));

          // Signing in again, as the media service's probe does.
          const second = jwtIssuedAt(Date.now(), 3600, "user|session-2");

          yield* connection.setAuth(ConvexTransport.fixedToken(second));

          return yield* connection
            .call("query", "account:viewer", { ask: 2 })
            .pipe(Effect.timeout(Duration.seconds(5)));
        }),
      ),
    );

    expect(answer).toBe("signed in");
  }, 20_000);

  it("drops a query from the connection once its caller stops waiting", async () => {
    const peak = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          // The connection drops before any answer, so every query the client holds is sent again.
          yield* fake.reply("account:viewer", Reply.Drop());
          const context = yield* Layer.build(ConvexTransport.layerWebSocket(fake.url));
          const connection = Context.get(context, ConvexTransport.ConvexTransport);

          for (let ask = 0; ask < 5; ask += 1) {
            yield* connection
              .call("query", "account:viewer", { ask })
              .pipe(Effect.timeoutOption(Duration.millis(300)));
          }

          yield* fake.reply("account:viewer", Reply.Success({ value: "answered" }));

          expect(
            yield* connection
              .call("query", "account:viewer", { ask: "last" })
              .pipe(Effect.timeout(Duration.seconds(10))),
          ).toBe("answered");

          return yield* fake.peakSubscriptions("account:viewer");
        }),
      ),
    );

    expect(peak).toBe(1);
  }, 20_000);

  it("runs signed out while the server keeps failing to renew the session, then signs in again", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;
          let refreshes = 0;
          let failing = true;

          // Signing in and the client's first refresh work; later refreshes fail until the server
          // recovers, and then renew the same session.
          yield* fake.handle("auth:signIn", (request) =>
            Effect.sync(() => {
              const refresh = Predicate.hasProperty(request.args, "refreshToken");

              if (refresh) refreshes += 1;

              return refresh && refreshes > 1 && failing
                ? Reply.Crash({ message: "Convex is busy" })
                : Reply.Success({
                    value: {
                      tokens: {
                        // One session throughout, as a renewal keeps it; the lifetime tells tokens apart.
                        token: jwtIssuedAt(Date.now(), 3600 + refreshes, "service|session"),
                        refreshToken: "refresh",
                      },
                    },
                  });
            }),
          );
          yield* fake.reply("account:viewer", Reply.Success({ value: "public answer" }));
          // Answers a signed-in connection only, as most queries do.
          yield* fake.handle("setup:status", (request) =>
            Effect.succeed(
              request.authorization === undefined
                ? Reply.Failure({ code: "unauthenticated", message: "Sign in first" })
                : Reply.Success({ value: { hasOwner: true, hasLibraries: refreshes > 1 } }),
            ),
          );

          const context = yield* Layer.build(
            MoviesClient.layer({ mediaUrl: Option.none() }).pipe(
              Layer.provideMerge(
                Auth.layer({ convexUrl: fake.url, refreshFailureLimit: Duration.seconds(5) }),
              ),
              Layer.provideMerge(ConvexTransport.layerWebSocket(fake.url)),
              Layer.provide(TokenStorage.layerMemory),
            ),
          );

          const auth = Context.get(context, Auth.Auth);
          const transport = Context.get(context, ConvexTransport.ConvexTransport);
          const client = Context.get(context, MoviesClient.MoviesClient);
          const seen = yield* Queue.unbounded<string>();

          yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("mk_service") }));
          yield* fake.acceptedTokens.pipe(
            Effect.repeat({
              until: (accepted) => new Set(accepted).size >= 2,
              schedule: Schedule.spaced("50 millis"),
            }),
            Effect.timeout(Duration.seconds(5)),
          );
          yield* client.subscribe("setup.status", {}).pipe(
            Stream.runForEach((status) =>
              Queue.offer(seen, `libraries: ${String(status.hasLibraries)}`),
            ),
            Effect.catch((error) => Queue.offer(seen, `failed: ${Struct.get(error, "_tag")}`)),
            Effect.forkScoped,
          );
          const first = yield* Queue.take(seen);

          // Convex stops the socket until the client hands it another token, or none.
          yield* fake.rejectAcceptedTokens;

          const answered = yield* transport
            .call("query", "account:viewer", { ask: 2 })
            .pipe(Effect.timeout(Duration.seconds(20)));

          const whileFailing = {
            status: yield* auth.currentStatus,
            reconnecting: yield* Stream.runHead(auth.reconnecting),
          };

          const asked = yield* client.query("setup.status", {}).pipe(
            Effect.map((status) => `libraries: ${String(status.hasLibraries)}`),
            Effect.catch((error) => Effect.succeed(`failed: ${Struct.get(error, "_tag")}`)),
            Effect.timeout(Duration.seconds(5)),
          );

          failing = false;
          yield* Stream.runHead(Stream.filter(auth.reconnecting, (waiting) => !waiting)).pipe(
            Effect.timeout(Duration.seconds(20)),
          );
          const later = yield* Queue.take(seen).pipe(Effect.timeout(Duration.seconds(5)));

          return {
            first,
            answered,
            whileFailing,
            asked,
            later,
            status: yield* auth.currentStatus,
          };
        }),
      ),
    );

    expect(outcome).toStrictEqual({
      first: "libraries: false",
      answered: "public answer",
      whileFailing: { status: "signedIn", reconnecting: Option.some(true) },
      // A one-shot query is not asked again: it fails as it would signed out.
      asked: "failed: Unauthenticated",
      later: "libraries: true",
      status: "signedIn",
    });
  }, 60_000);

  it("stops asking for a token once closed", async () => {
    const { stopped, later } = await asksAround((_, scope) => Scope.close(scope, Exit.void));

    expect(later).toBe(stopped);
  }, 15_000);
});

describe("clientTokenFetchers", () => {
  it("never asks a retired fetcher's source again", async () => {
    const fetchers = clientTokenFetchers();
    const installed: Array<AuthTokenFetcher> = [];
    let asked = 0;

    await fetchers.install(
      () => {
        asked += 1;

        return Promise.resolve(issuedOf("token"));
      },
      (given) => {
        if (given !== null) installed.push(given);
      },
    );
    await fetchers.install(null, () => undefined);

    const [retired] = installed;

    if (retired === undefined) throw new Error("A source gives a fetcher");

    expect(await retired({ forceRefreshToken: false })).toBeNull();
    expect(await retired({ forceRefreshToken: true })).toBeNull();
    expect(asked).toBe(0);
  });

  it("keeps installing after one install fails, as on a client the app already closed", async () => {
    const fetchers = clientTokenFetchers();
    const applied: Array<AuthTokenFetcher | null> = [];

    const failed = fetchers.install(null, () => {
      throw new Error("ConvexReactClient has already been closed.");
    });

    await expect(failed).rejects.toThrow("already been closed");
    await fetchers.install(null, (given) => {
      applied.push(given);
    });

    expect(applied).toStrictEqual([null]);
  });

  it("compares a refreshed token with the newest fetch's answer, the only one the client keeps", async () => {
    // The client keeps only the answer of the fetch it started last; an older one still out
    // when a newer one starts is discarded when it lands.
    const answers: Array<(issued: ConvexTransport.IssuedToken) => void> = [];
    let asked = 0;

    const installed: Array<AuthTokenFetcher> = [];

    await clientTokenFetchers().install(
      () => {
        asked += 1;

        return new Promise((resolve) => {
          answers.push(resolve);
        });
      },
      (given) => {
        if (given !== null) installed.push(given);
      },
    );

    const [fetcher] = installed;

    if (fetcher === undefined) throw new Error("A source gives a fetcher");
    const discarded = fetcher({ forceRefreshToken: true });
    const kept = fetcher({ forceRefreshToken: true });

    answers[1]?.(issuedOf("token-2"));
    expect(await kept).toBe("token-2");
    answers[0]?.(issuedOf("token-3"));
    expect(await discarded).toBe("token-3");

    // The client holds token-2, so token-3 is new to it and comes back without asking again.
    const next = fetcher({ forceRefreshToken: true });

    answers[2]?.(issuedOf("token-3"));

    const answer = await Promise.race([
      next,
      new Promise((resolve) => {
        setTimeout(() => {
          resolve("asked again");
        }, 500);
      }),
    ]);

    expect(answer).toBe("token-3");
    expect(asked).toBe(3);
  });
});

describe("translateFailure", () => {
  it("turns ConvexError data into the command error for its code", () => {
    const error = translateFailure(
      "rooms:play",
      new ConvexError({ code: "stale_revision", message: "The room changed" }),
    );

    expect(error).toMatchObject({ _tag: "StaleRevision", message: "The room changed" });
  });

  it("reports ConvexError data without a known code as a protocol error", () => {
    expect(translateFailure("x:y", new ConvexError({ code: "nope", message: "?" }))).toMatchObject({
      _tag: "ProtocolError",
    });
  });

  it("treats Convex rejecting the token as a signed-out session", () => {
    const rejected = new Error(
      JSON.stringify({ code: "Unauthenticated", message: "Could not verify OIDC token claim" }),
    );

    expect(translateFailure("account:viewer", rejected)).toMatchObject({ _tag: "Unauthenticated" });
  });

  it("reports an argument that is not an ID of its table as not found", () => {
    const overHttp = new Error(
      '[Request ID: 55c324b842b35e1b] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .titleId\nValue: "nope"\nValidator: v.id("titles")\n\n',
    );

    const overWebSocket = new Error(
      '[CONVEX Q(titles:get)] [Request ID: 8d858a8ee2675929] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .profileId\nValue: "nope"\nValidator: v.id("profiles")\n\n\n  Called by client',
    );

    const fromAnotherTable = new Error(
      '[Request ID: af9a287f7de12fe1] Server Error\nArgumentValidationError: Found ID "md72x7j3s82e23sy3q1h1y2r7d8g7jvw" from table `profiles`, which does not match the table name in validator `v.id("titles")`.Path: .titleId\n\n',
    );

    expect(translateFailure("titles:get", overHttp)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", overWebSocket)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", fromAnotherTable)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
  });

  it("keeps other argument failures and crashes internal", () => {
    const badNumber = new Error(
      '[Request ID: 1] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .limit\nValue: "x"\nValidator: v.number()\n\n',
    );

    const crashMentioningIds = new Error(
      '[Request ID: 1] Server Error\nUncaught Error: expected Validator: v.id("titles")',
    );

    expect(translateFailure("x:y", badNumber)).toMatchObject({ _tag: "Internal" });
    expect(translateFailure("x:y", crashMentioningIds)).toMatchObject({ _tag: "Internal" });
  });

  it("separates crashed functions from network failures", () => {
    expect(translateFailure("x:y", new Error("[Request ID: 1] Server Error"))).toMatchObject({
      _tag: "Internal",
    });
    expect(translateFailure("x:y", new TypeError("fetch failed"))).toMatchObject({
      _tag: "TransportError",
    });
  });
});
