import { targetPosition } from "@media/contracts/clock";
import type { CommandError } from "@media/contracts/errors";
import { DeviceId } from "@media/contracts/ids";
import type { ProfileId, TitleId } from "@media/contracts/ids";
import { mediaServiceFunctions } from "@media/contracts/media-service";
import { Milliseconds } from "@media/contracts/units";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schema,
  Stream,
  Struct,
} from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as Auth from "../auth";
import * as ConvexTransport from "../convex-transport";
import * as DeviceLogin from "../device-login";
import * as Movies from "../movies";
import { MoviesClient, layer as moviesClientLayer } from "../movies-client";
import { hostControlsEnabled, run } from "../room-sync/room-sync";
import { DEFAULT_TUNABLES } from "../room-sync/sync-policy";
import type { CallError } from "../sdk-errors";
import * as FakeConvex from "../testing/fake-convex";
import { Reply } from "../testing/fake-convex";
import { makeFakePlayer } from "../testing/fake-player";
import { findStack } from "../testing/stack-env";
import * as TokenStorage from "../token-storage";

const stack = findStack();

const url = stack?.convexUrl ?? "";

const PASSWORD = "stack-test-password";

const OWNER_EMAILS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

const id = Math.random().toString(36).slice(2, 8);

type Session = Context.Context<Movies.Services | ConvexTransport.ConvexTransport>;

const open = (connection: "websocket" | "http") =>
  Layer.build(
    Movies.layerWithTransport({ convexUrl: url, mediaUrl: Option.none() }).pipe(
      Layer.provideMerge(
        connection === "websocket"
          ? ConvexTransport.layerWebSocket(url)
          : ConvexTransport.layerHttp(url),
      ),
      Layer.provide(TokenStorage.layerMemory),
    ),
  );

const as =
  (session: Session) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, session);

const clientOf = (session: Session) => Context.get(session, MoviesClient);

const password = (email: string, flow: "signIn" | "signUp", inviteCode?: string) =>
  Auth.Credentials.Password({
    flow,
    email,
    password: Redacted.make(PASSWORD),
    name: Option.none(),
    inviteCode: Option.fromNullishOr(inviteCode),
  });

const signIn = (credentials: Auth.Credentials) =>
  Effect.flatMap(Auth.Auth, (auth) => auth.signIn(credentials));

const outcome = <A, R>(
  effect: Effect.Effect<A, CallError | CommandError | TokenStorage.TokenStorageError, R>,
) =>
  effect.pipe(
    Effect.as("succeeded"),
    Effect.catch((error) => Effect.succeed(Struct.get(error, "_tag"))),
  );

const ownerSession = Effect.gen(function* () {
  const session = yield* open("websocket");
  const status = yield* clientOf(session).query("setup.status", {});

  if (!status.hasOwner) {
    yield* as(session)(signIn(password(OWNER_EMAILS[0], "signUp")));

    return session;
  }

  for (const email of OWNER_EMAILS) {
    const result = yield* as(session)(outcome(signIn(password(email, "signIn"))));

    if (result === "succeeded") return session;
  }

  return yield* Effect.die(new Error("The backend has an owner from elsewhere; use a fresh stack"));
});

const scannedItem = (path: string, name: string) => ({
  file: {
    path,
    sizeBytes: 1_000_000,
    mtimeMs: 1_760_000_000_000,
    probe: {
      container: "mp4",
      durationMs: 600_000,
      bitRate: 5_000_000,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "High",
          width: 1920,
          height: 1080,
          frameRate: 23.976,
          bitDepth: 8,
          pixelFormat: "yuv420p",
          hdr: "none",
          bitRate: null,
        },
      ],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    versionName: null,
  },
  title: {
    kind: "movie",
    matchKey: `local:${name.toLowerCase()}`,
    name,
    sortName: null,
    year: 2024,
    overview: null,
    tagline: null,
    genres: [],
    certification: null,
    ageRating: 0,
    runtimeMs: 600_000,
    artwork: { poster: null, backdrop: null, logo: null },
    externalIds: { tmdb: null, imdb: null, tvdb: null },
    matchStatus: "unmatched",
  },
  episode: null,
});

const UpsertArgs = mediaServiceFunctions["mediaService.upsertScanned"].args;

const seedTitle = (owner: Session, ownerProfile: ProfileId) =>
  Effect.gen(function* () {
    const ownerClient = clientOf(owner);
    const name = `Room Movie sdk${id}`;

    const { libraryId } = yield* ownerClient.mutate("libraries.create", {
      name: `SDK ${id}`,
      kind: "movies",
      roots: [`/sdk-stack-${id}`],
    });

    const media = yield* open("http");

    yield* as(media)(
      signIn(Auth.Credentials.ApiKey({ key: Redacted.make(stack?.mediaServiceKey ?? "") })),
    );

    const wire = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(UpsertArgs))(
      yield* Schema.decodeUnknownEffect(UpsertArgs)({
        libraryId,
        items: [scannedItem(`/sdk-stack-${id}/movie.mp4`, name)],
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)), Effect.orDie);

    const transport = Context.get(media, ConvexTransport.ConvexTransport);

    yield* transport.call("mutation", "mediaService:upsertScanned", wire);

    const found = yield* ownerClient.query("titles.search", {
      profileId: ownerProfile,
      query: name,
      limit: 5,
    });

    const [title] = found;

    if (title === undefined) return yield* Effect.die(new Error("The seeded title is not visible"));

    return title.id;
  });

const firstProfile = (session: Session) =>
  Effect.gen(function* () {
    const [profile] = yield* clientOf(session).query("profiles.list", {});

    if (profile === undefined) return yield* Effect.die(new Error("An account has no profile"));

    return profile.id;
  });

const forwardAuth = (path: "auth:signIn" | "auth:signOut", request: FakeConvex.RecordedRequest) =>
  Effect.gen(function* () {
    const args = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(request.args);
    const gateway = new ConvexHttpClient(url, { logger: false });

    if (request.authorization !== undefined) {
      gateway.setAuth(request.authorization.replace(/^Bearer /u, ""));
    }

    const value = yield* Effect.promise(() =>
      gateway.action(makeFunctionReference<"action", Schema.JsonObject, Schema.Json>(path), args),
    );

    return Reply.Success({ value });
  }).pipe(Effect.orDie);

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

describe.skipIf(stack === undefined)("the SDK against a real stack", () => {
  it(
    "signs in with a password and reads the viewer over both connections",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const viewer = yield* clientOf(owner).query("account.viewer", {});

          expect(viewer.user.role).toBe("owner");
          expect(viewer.sessionKind).toBe("password");

          const http = yield* open("http");

          yield* as(http)(signIn(password(viewer.user.email ?? "", "signIn")));
          expect((yield* clientOf(http).query("account.viewer", {})).user.id).toBe(viewer.user.id);
        }),
      ),
    60_000,
  );

  it(
    "refreshes the token on demand and signs out on the server",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const auth = Context.get(owner, Auth.Auth);
          const before = yield* auth.accessToken(false);
          // JWTs carry second-resolution timestamps; a refresh in the same second is identical.
          yield* Effect.sleep("1100 millis");
          const after = yield* auth.accessToken(true);

          expect(Option.isSome(after)).toBe(true);
          expect(Option.map(after, Redacted.value)).not.toStrictEqual(
            Option.map(before, Redacted.value),
          );
          expect(yield* outcome(clientOf(owner).query("account.viewer", {}))).toBe("succeeded");

          yield* auth.signOut;
          expect(yield* auth.currentStatus).toBe("signedOut");
          expect(yield* outcome(clientOf(owner).query("account.viewer", {}))).toBe(
            "Unauthenticated",
          );
        }),
      ),
    60_000,
  );

  it(
    "keeps an API key's session when a refresh of it lands after signing in again",
    () =>
      runScoped(
        Effect.gen(function* () {
          const relay = yield* FakeConvex.make;
          const refreshed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const ended = yield* Deferred.make<void>();

          yield* relay.handle("auth:signIn", (request) =>
            forwardAuth("auth:signIn", request).pipe(
              Effect.tap(() =>
                Predicate.hasProperty(request.args, "refreshToken")
                  ? Deferred.succeed(refreshed, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
              ),
            ),
          );
          yield* relay.handle("auth:signOut", (request) =>
            forwardAuth("auth:signOut", request).pipe(
              Effect.tap(() => Deferred.succeed(ended, undefined)),
            ),
          );

          const service = yield* Layer.build(
            Auth.layer({ convexUrl: relay.url }).pipe(
              Layer.provideMerge(ConvexTransport.layerHttp(url)),
              Layer.provide(TokenStorage.layerMemory),
            ),
          );

          const auth = Context.get(service, Auth.Auth);
          const key = Auth.Credentials.ApiKey({ key: Redacted.make(stack?.mediaServiceKey ?? "") });

          yield* auth.signIn(key);
          const refreshing = yield* Effect.forkChild(auth.accessToken(true));

          // The stack renewed the session; its answer is late, as when the media service's probe
          // signs in again while a refresh is still on its way back.
          yield* Deferred.await(refreshed);
          yield* auth.signIn(key);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(refreshing);
          yield* Deferred.await(ended).pipe(Effect.timeoutOption("2 seconds"));

          const transport = Context.get(service, ConvexTransport.ConvexTransport);

          expect(
            yield* outcome(
              transport.call("query", "mediaService:sessionStatus", { sessionId: "none" }),
            ),
          ).toBe("succeeded");
        }),
      ),
    60_000,
  );

  it(
    "keeps a session the server fails to renew for a while, and renews it once the server recovers",
    () =>
      runScoped(
        Effect.gen(function* () {
          const relay = yield* FakeConvex.make;
          let failing = true;

          // Refreshes fail as when the server's auth function is broken for a while; everything
          // else, and every refresh once it recovers, reaches the stack.
          yield* relay.handle("auth:signIn", (request) =>
            failing && Predicate.hasProperty(request.args, "refreshToken")
              ? Effect.succeed(Reply.Crash({ message: "Temporary auth failure" }))
              : forwardAuth("auth:signIn", request),
          );

          const items = new Map<string, string>();

          const service = yield* Layer.build(
            Auth.layer({ convexUrl: relay.url, refreshFailureLimit: Duration.seconds(1) }).pipe(
              Layer.provideMerge(ConvexTransport.layerWebSocket(url)),
              Layer.provide(
                TokenStorage.layerKeyValue(
                  {
                    getItem: (key) => items.get(key) ?? null,
                    setItem: (key, value) => {
                      items.set(key, value);
                    },
                    removeItem: (key) => {
                      items.delete(key);
                    },
                  },
                  "session",
                ),
              ),
            ),
          );

          const auth = Context.get(service, Auth.Auth);
          const transport = Context.get(service, ConvexTransport.ConvexTransport);

          const sessionStatus = outcome(
            transport.call("query", "mediaService:sessionStatus", { sessionId: "none" }),
          );

          yield* auth.signIn(
            Auth.Credentials.ApiKey({ key: Redacted.make(stack?.mediaServiceKey ?? "") }),
          );
          const stored = items.get("session");

          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) yield* Effect.sleep("600 millis");
            yield* auth.accessToken(true);
          }

          expect({
            status: yield* auth.currentStatus,
            kept: items.get("session") === stored,
          }).toStrictEqual({
            status: "signedIn",
            kept: true,
          });

          const whileFailing = {
            reconnecting: yield* Stream.runHead(auth.reconnecting),
            sessionStatus: yield* sessionStatus,
            setup: yield* outcome(transport.call("query", "setup:status", {})),
          };

          failing = false;
          yield* Stream.runHead(Stream.filter(auth.reconnecting, (waiting) => !waiting)).pipe(
            Effect.timeout("10 seconds"),
          );

          const refreshedWith = (yield* relay.requestsTo("auth:signIn")).flatMap((request) =>
            Predicate.hasProperty(request.args, "refreshToken") ? [request.args.refreshToken] : [],
          );

          expect(whileFailing).toStrictEqual({
            reconnecting: Option.some(true),
            sessionStatus: "Unauthenticated",
            setup: "succeeded",
          });
          expect(new Set(refreshedWith).size).toBe(1);
          expect(yield* sessionStatus).toBe("succeeded");
          expect(yield* auth.currentStatus).toBe("signedIn");
        }),
      ),
    60_000,
  );

  it(
    "runs nothing one account asked while reconnecting as the account that signs in next",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const email = `switch-${id}@movies.test`;
          const invite = yield* clientOf(owner).action("invites.create", { email, role: "member" });
          const relay = yield* FakeConvex.make;

          yield* relay.handle("auth:signIn", (request) =>
            Predicate.hasProperty(request.args, "refreshToken")
              ? Effect.succeed(Reply.Crash({ message: "Temporary auth failure" }))
              : forwardAuth("auth:signIn", request),
          );

          const service = yield* Layer.build(
            moviesClientLayer({ mediaUrl: Option.none() }).pipe(
              Layer.provideMerge(
                Auth.layer({ convexUrl: relay.url, refreshFailureLimit: Duration.seconds(1) }),
              ),
              Layer.provideMerge(ConvexTransport.layerWebSocket(url)),
              Layer.provide(TokenStorage.layerMemory),
            ),
          );

          const auth = Context.get(service, Auth.Auth);
          const client = Context.get(service, MoviesClient);
          const seen = yield* Queue.unbounded<string>();

          yield* auth.signIn(password(email, "signUp", invite.code));
          yield* client.subscribe("profiles.list", {}).pipe(
            Stream.runForEach((profiles) =>
              Queue.offer(seen, `${String(profiles.length)} profiles`),
            ),
            Effect.catch((error) => Queue.offer(seen, `failed: ${Struct.get(error, "_tag")}`)),
            Effect.forkScoped,
          );
          yield* Queue.take(seen);

          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) yield* Effect.sleep("600 millis");
            yield* auth.accessToken(true);
          }

          const pending = yield* outcome(
            client.mutate("profiles.create", { name: `pending ${id}`, avatar: "red", kids: false }),
          ).pipe(Effect.forkScoped);

          yield* Effect.sleep("500 millis");
          yield* Effect.firstSuccessOf(
            OWNER_EMAILS.map((owned) => auth.signIn(password(owned, "signIn"))),
          );

          const mutation = yield* Fiber.join(pending).pipe(Effect.timeout("40 seconds"));
          const subscription = yield* Queue.take(seen).pipe(Effect.timeout("10 seconds"));
          const ownerProfiles = yield* clientOf(owner).query("profiles.list", {});

          expect({
            mutation,
            subscription,
            crossed: ownerProfiles.some((profile) => profile.name === `pending ${id}`),
          }).toStrictEqual({
            mutation: "Unauthenticated",
            subscription: "failed: Unauthenticated",
            crossed: false,
          });
        }),
      ),
    90_000,
  );

  it(
    "signs out once the server no longer knows the session's refresh token",
    () =>
      runScoped(
        Effect.gen(function* () {
          yield* ownerSession;
          const gateway = new ConvexHttpClient(url, { logger: false });

          const action = (path: "auth:signIn" | "auth:signOut", args: Schema.JsonObject) =>
            Effect.tryPromise(() =>
              gateway.action(
                makeFunctionReference<"action", Schema.JsonObject, Schema.Json>(path),
                args,
              ),
            );

          const decodeTokens = Schema.decodeUnknownEffect(
            Schema.Struct({
              tokens: Schema.Struct({ token: Schema.String, refreshToken: Schema.String }),
            }),
          );

          const { tokens } = yield* Effect.firstSuccessOf(
            OWNER_EMAILS.map((email) =>
              action("auth:signIn", {
                provider: "password",
                params: { flow: "signIn", email, password: PASSWORD },
              }).pipe(Effect.flatMap(decodeTokens)),
            ),
          );

          gateway.setAuth(tokens.token);
          yield* action("auth:signOut", {});
          gateway.clearAuth();

          // Convex Auth's one definitive refusal of a refresh: a successful answer with no tokens.
          expect(yield* action("auth:signIn", { refreshToken: tokens.refreshToken })).toStrictEqual(
            {
              tokens: null,
            },
          );

          const items = new Map([
            [
              "session",
              TokenStorage.serializeSession({
                token: Redacted.make(tokens.token),
                refreshToken: Redacted.make(tokens.refreshToken),
              }),
            ],
          ]);

          const service = yield* Layer.build(
            Auth.layer({ convexUrl: url }).pipe(
              Layer.provide(ConvexTransport.layerHttp(url)),
              Layer.provide(
                TokenStorage.layerKeyValue(
                  {
                    getItem: (key) => items.get(key) ?? null,
                    setItem: (key, value) => {
                      items.set(key, value);
                    },
                    removeItem: (key) => {
                      items.delete(key);
                    },
                  },
                  "session",
                ),
              ),
            ),
          );

          const auth = Context.get(service, Auth.Auth);

          expect(yield* auth.currentStatus).toBe("signedIn");
          expect(yield* auth.accessToken(true)).toStrictEqual(Option.none());
          expect(yield* auth.currentStatus).toBe("signedOut");
          expect(items.has("session")).toBe(false);
        }),
      ),
    60_000,
  );

  it(
    "signs in with a scoped API key until the key is revoked",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const ownerClient = Context.get(owner, MoviesClient);

          const created = yield* as(owner)(
            ownerClient.action("apiKeys.create", { name: `SDK ${id}`, scopes: ["read"] }),
          );

          const agent = yield* open("http");

          yield* as(agent)(signIn(Auth.Credentials.ApiKey({ key: Redacted.make(created.secret) })));
          const agentClient = Context.get(agent, MoviesClient);
          const viewer = yield* agentClient.query("account.viewer", {});

          expect(viewer).toMatchObject({ sessionKind: "apikey", scopes: ["read"] });
          expect(
            yield* outcome(agentClient.action("apiKeys.create", { name: "x", scopes: ["read"] })),
          ).toBe("Forbidden");

          yield* ownerClient.mutate("apiKeys.revoke", { apiKeyId: created.apiKey.id });
          expect(yield* outcome(agentClient.query("account.viewer", {}))).toBe("Unauthenticated");

          const again = yield* open("http");

          expect(
            yield* as(again)(
              outcome(signIn(Auth.Credentials.ApiKey({ key: Redacted.make(created.secret) }))),
            ),
          ).toBe("Unauthenticated");
        }),
      ),
    60_000,
  );

  it(
    "completes a device sign-in approved from another session",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const device = yield* open("websocket");
          const login = yield* as(device)(DeviceLogin.start(`SDK TV ${id}`));
          const waiting = yield* Effect.forkChild(login.complete);

          yield* clientOf(owner).mutate("deviceAuth.approve", {
            userCode: login.userCode,
            scopes: ["read", "play"],
          });

          yield* Fiber.join(waiting);
          const viewer = yield* clientOf(device).query("account.viewer", {});

          expect(viewer).toMatchObject({ sessionKind: "device", scopes: ["read", "play"] });
          expect(yield* Context.get(device, Auth.Auth).currentStatus).toBe("signedIn");
        }),
      ),
    60_000,
  );

  it(
    "keeps a guest on the host's timeline in a real room and rejects guest controls",
    () =>
      runScoped(
        Effect.gen(function* () {
          const owner = yield* ownerSession;
          const ownerClient = Context.get(owner, MoviesClient);
          const ownerProfile = yield* firstProfile(owner);
          const titleId: TitleId = yield* seedTitle(owner, ownerProfile);
          const email = `sdk-guest-${id}@movies.test`;
          const invite = yield* ownerClient.action("invites.create", { email, role: "member" });
          const guest = yield* open("websocket");

          yield* as(guest)(signIn(password(email, "signUp", invite.code)));
          const guestClient = Context.get(guest, MoviesClient);
          const guestProfile = yield* firstProfile(guest);
          const hostDevice = DeviceId.make(`sdk-host-${id}`);
          const guestDevice = DeviceId.make(`sdk-guest-${id}`);

          const room = yield* ownerClient.mutate("rooms.create", {
            profileId: ownerProfile,
            deviceId: hostDevice,
            titleId,
            positionMs: Milliseconds.make(0),
          });

          yield* guestClient.mutate("rooms.join", {
            roomId: room.id,
            profileId: guestProfile,
            deviceId: guestDevice,
          });

          const hostPlayer = yield* makeFakePlayer(0);
          const guestPlayer = yield* makeFakePlayer(0);
          const options = { roomId: room.id, player: hostPlayer, tunables: DEFAULT_TUNABLES };
          const host = yield* as(owner)(run({ ...options, deviceId: hostDevice }));

          yield* as(guest)(run({ ...options, deviceId: guestDevice, player: guestPlayer }));
          expect(hostControlsEnabled(yield* host.current)).toBe(true);

          hostPlayer.userSeek(42_000);
          hostPlayer.userPlay();
          yield* Effect.sleep("3 seconds");

          const committed = yield* guestClient.query("rooms.get", { roomId: room.id });

          expect(committed.clock.status).toBe("playing");
          expect(guestPlayer.isPaused()).toBe(false);
          expect(Math.abs(guestPlayer.positionMs() - hostPlayer.positionMs())).toBeLessThan(250);

          const seen = yield* guestClient
            .subscribe("rooms.get", { roomId: room.id })
            .pipe(Stream.take(1), Stream.runCollect);

          expect(seen.map((r) => r.clock.revision)).toStrictEqual([committed.clock.revision]);

          const live = targetPosition(committed.clock, committed.clock.anchorServerTime);

          expect(
            yield* outcome(
              guestClient.mutate("rooms.pause", {
                roomId: room.id,
                deviceId: guestDevice,
                revision: committed.clock.revision,
                positionMs: live,
              }),
            ),
          ).toBe("Forbidden");

          hostPlayer.userPause();
          yield* Effect.sleep("1500 millis");
          expect(guestPlayer.isPaused()).toBe(true);
          expect(Math.abs(guestPlayer.positionMs() - hostPlayer.positionMs())).toBeLessThan(250);

          yield* ownerClient.mutate("rooms.end", { roomId: room.id, deviceId: hostDevice });
        }),
      ),
    90_000,
  );
});
