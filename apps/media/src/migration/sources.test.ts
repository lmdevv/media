import type { MigrationCredentials } from "@media/contracts/models/migration";
import { assert, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import type { SourceError, SourceSession } from "./source-plugin.ts";
import { failureReasonOf } from "./source-plugin.ts";
import { openSource } from "./sources.ts";
import {
  FIXTURE_API_KEY,
  fixturePassword,
  jellyfinIdentity,
  jellyfinRecording,
  startJellyfinFixture,
} from "./testing/jellyfin-fixture.ts";
import {
  FIXTURE_PLEX_TOKEN,
  FIXTURE_SHARED_TOKEN,
  startPlexFixture,
} from "./testing/plex-fixture.ts";
import type { RecordedServer } from "./testing/recorded-server.ts";
import { startRecordedServer } from "./testing/recorded-server.ts";

const token = (value: string): MigrationCredentials => ({
  kind: "token",
  token: Redacted.make(value),
});

const password = (username: string, value: string): MigrationCredentials => ({
  kind: "password",
  username,
  password: Redacted.make(value),
});

const withServer = <A, E, R>(
  start: () => Promise<RecordedServer>,
  use: (server: RecordedServer) => Effect.Effect<A, E, R>,
) => Effect.acquireUseRelease(Effect.promise(start), use, (server) => Effect.promise(server.close));

const readAll = (session: SourceSession) =>
  Effect.all({
    items: session.items,
    collections: session.collections,
    states: Effect.forEach(session.users, (user) =>
      session.userStates(user).pipe(Effect.map((states) => [user.name, states] as const)),
    ),
  });

const reason = <A, R>(effect: Effect.Effect<A, SourceError, R>) =>
  effect.pipe(Effect.flip, Effect.map(failureReasonOf));

const refusal = (source: "jellyfin" | "plex", url: string, credentials: MigrationCredentials) =>
  reason(openSource(source, { url, credentials }));

const { ids } = jellyfinRecording;

const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const withInfo = (body: Schema.Json) => () =>
  startRecordedServer(
    { ...jellyfinRecording.recordings, "-|GET /System/Info/Public": { status: 200, body } },
    jellyfinIdentity,
  );

const decodeName = Schema.decodeUnknownSync(Schema.Struct({ Name: Schema.String }));

const decodeUsers = Schema.decodeUnknownSync(
  Schema.Array(Schema.Record(Schema.String, Schema.Json)),
);

const withPolicies =
  (policy: (name: string, recorded: Readonly<Record<string, Schema.Json>>) => Schema.Json) =>
  () => {
    const recorded = jellyfinRecording.recordings["apikey|GET /Users"];

    if (recorded === undefined) throw new Error("The recording has no GET /Users");

    const body = decodeUsers(recorded.body).map((user) =>
      Object.fromEntries(
        Object.entries(user).map(([key, value]) => [
          key,
          key === "Policy" ? policy(decodeName(user).Name, decodeObject(value)) : value,
        ]),
      ),
    );

    return startRecordedServer(
      { ...jellyfinRecording.recordings, "apikey|GET /Users": { status: 200, body } },
      jellyfinIdentity,
    );
  };

const dashed = (id: string): string =>
  [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join("-");

const refusedKey = (server: RecordedServer) =>
  refusal("jellyfin", server.url, token(FIXTURE_API_KEY));

layer(FetchHttpClient.layer, { excludeTestServices: true })(
  "Jellyfin plugin (recorded from Jellyfin 12.2)",
  (it) => {
    it.effect("reads users, libraries, items, watch state, collections, and locked fields", () =>
      withServer(startJellyfinFixture, (server) =>
        Effect.gen(function* () {
          const session = yield* openSource("jellyfin", {
            url: server.url,
            credentials: token(FIXTURE_API_KEY),
          });

          assert.strictEqual(session.server.version, jellyfinRecording.version);
          assert.deepStrictEqual(
            session.users.map((user) => [user.name, user.isAdmin, user.history]),
            [
              ["admin", true, "full"],
              ["bob", false, "full"],
            ],
          );
          assert.deepStrictEqual(
            session.libraries.map((library) => [
              library.name,
              library.kind,
              library.paths,
              library.access,
            ]),
            [
              ["Shows", "shows", ["/media/shows"], { kind: "everyone" }],
              ["Movies", "movies", ["/media/movies"], { kind: "everyone" }],
              ["Collections", "other", ["/config/data/collections"], { kind: "everyone" }],
            ],
          );

          const { items, collections, states } = yield* readAll(session);

          assert.strictEqual(items.filter((item) => item.kind === "movie").length, 4);
          assert.strictEqual(items.filter((item) => item.kind === "episode").length, 6);

          const bigBuck = items.find((item) => item.itemId === ids["bigBuck"]);

          assert.deepStrictEqual(bigBuck?.ids, { tmdb: "10378", imdb: "tt1254207", tvdb: null });
          assert.deepStrictEqual(bigBuck?.paths, [
            "/media/movies/Big Buck Fixture (2008)/Big Buck Fixture (2008).mp4",
          ]);
          assert.strictEqual(bigBuck?.overrides.name, "Big Buck Fixture (Director's Cut)");
          assert.strictEqual(bigBuck?.overrides.sortName, "Fixture, Big Buck");

          const pilot = items.find((item) => item.itemId === ids["pilot"]);

          assert.deepStrictEqual(
            [pilot?.seriesId, pilot?.seasonNumber, pilot?.episodeNumber],
            [ids["show"], 1, 1],
          );

          const [admin, bob] = states;

          assert.deepStrictEqual(
            admin?.[1].map((state) => [
              state.itemId,
              state.played,
              state.positionMs,
              state.favorite,
            ]),
            [
              [ids["bigBuck"], true, 0, false],
              [ids["remux"], false, 6000, false],
              [ids["show"], false, 0, true],
            ],
          );
          assert.deepStrictEqual(
            bob?.[1].map((state) => [state.itemId, state.played]),
            [[ids["pilot"], true]],
          );
          assert.deepStrictEqual(collections, [
            {
              collectionId: ids["boxSet"] ?? "",
              name: "Fixture Box",
              sortName: null,
              itemIds: [ids["bigBuck"] ?? "", ids["remux"] ?? ""],
            },
          ]);
          assert.isTrue(
            server.requests.every(
              (request) =>
                request.method === "GET" ||
                (request.method === "POST" && request.path === "/Users/AuthenticateByName"),
            ),
          );
        }),
      ),
    );

    it.effect("shares a library with the users whose policies enable its folder", () =>
      Effect.gen(function* () {
        const libraries = yield* withServer(startJellyfinFixture, (server) =>
          openSource("jellyfin", { url: server.url, credentials: token(FIXTURE_API_KEY) }).pipe(
            Effect.map((session) => session.libraries),
          ),
        );

        const movies = libraries.find((library) => library.name === "Movies")?.libraryId ?? "";

        const restricted = withPolicies((name, recorded) =>
          name === "bob"
            ? { ...recorded, EnableAllFolders: false, EnabledFolders: [dashed(movies)] }
            : recorded,
        );

        const session = yield* withServer(restricted, (server) =>
          openSource("jellyfin", { url: server.url, credentials: token(FIXTURE_API_KEY) }),
        );

        const admin = session.users.find((user) => user.name === "admin")?.userId ?? "";

        assert.deepStrictEqual(
          session.libraries.map((library) => [library.name, library.access]),
          [
            ["Shows", { kind: "users", userIds: [admin] }],
            ["Movies", { kind: "everyone" }],
            ["Collections", { kind: "users", userIds: [admin] }],
          ],
        );
        assert.notStrictEqual(admin, "");
      }),
    );

    it.effect("says nothing about access when the server has no active users", () =>
      withServer(
        withPolicies((_name, recorded) => ({ ...recorded, IsDisabled: true })),
        (server) =>
          Effect.gen(function* () {
            const session = yield* openSource("jellyfin", {
              url: server.url,
              credentials: token(FIXTURE_API_KEY),
            });

            assert.deepStrictEqual(session.users, []);
            assert.deepStrictEqual(
              session.libraries.map((library) => library.access),
              [{ kind: "unknown" }, { kind: "unknown" }, { kind: "unknown" }],
            );
          }),
      ),
    );

    it.effect("signs in with an administrator's password", () =>
      withServer(startJellyfinFixture, (server) =>
        Effect.gen(function* () {
          const session = yield* openSource("jellyfin", {
            url: server.url,
            credentials: password("admin", fixturePassword("admin")),
          });

          assert.strictEqual(session.users.length, 2);
          assert.isTrue(server.requests.some((request) => request.method === "POST"));
        }),
      ),
    );

    it.effect("reports why it could not connect", () =>
      withServer(startJellyfinFixture, (server) =>
        Effect.gen(function* () {
          const open = (credentials: MigrationCredentials) =>
            refusal("jellyfin", server.url, credentials);

          assert.strictEqual(yield* open(token("wrong")), "auth_failed");
          assert.strictEqual(yield* open(password("admin", "wrong")), "auth_failed");
          assert.strictEqual(yield* open(password("bob", fixturePassword("bob"))), "not_admin");

          assert.strictEqual(
            yield* refusal("jellyfin", "http://127.0.0.1:1", token(FIXTURE_API_KEY)),
            "unreachable",
          );
        }),
      ),
    );

    it.effect("refuses servers older than 10.8 and answers that are not Jellyfin's", () =>
      Effect.gen(function* () {
        const info = jellyfinRecording.recordings["-|GET /System/Info/Public"];

        const old = { ...decodeObject(info?.body), version: "10.7.7" };

        assert.strictEqual(yield* withServer(withInfo(old), refusedKey), "version_unsupported");

        assert.strictEqual(
          yield* withServer(withInfo({ hello: 1 }), refusedKey),
          "unexpected_response",
        );
      }),
    );
  },
);

layer(FetchHttpClient.layer, { excludeTestServices: true })(
  "Plex plugin (written from the Plex API documentation)",
  (it) => {
    it.effect(
      "reads libraries, items, the owner's state, other accounts' plays, and collections",
      () =>
        withServer(
          () => startPlexFixture(),
          (server) =>
            Effect.gen(function* () {
              const session = yield* openSource("plex", {
                url: server.url,
                credentials: token(FIXTURE_PLEX_TOKEN),
              });

              assert.deepStrictEqual(session.server, {
                serverId: "fixture-machine-id",
                name: "Fixture Plex",
                version: "1.41.3.9314-a0bfb8370",
              });
              assert.deepStrictEqual(
                session.users.map((user) => [user.userId, user.name, user.history]),
                [
                  ["1", "Admin", "full"],
                  ["2", "bob", "plays"],
                ],
              );
              assert.deepStrictEqual(
                session.libraries.map((library) => [library.name, library.kind, library.access]),
                [
                  ["Movies", "movies", { kind: "unknown" }],
                  ["TV Shows", "shows", { kind: "unknown" }],
                  ["Music", "other", { kind: "unknown" }],
                ],
              );

              const { items, collections, states } = yield* readAll(session);
              const bigBuck = items.find((item) => item.itemId === "101");

              assert.deepStrictEqual(bigBuck?.ids, {
                tmdb: "10378",
                imdb: "tt1254207",
                tvdb: null,
              });
              assert.deepStrictEqual(bigBuck?.overrides, {
                sortName: "Fixture, Big Buck",
                overview: "A rabbit & a test pattern.",
              });
              assert.deepStrictEqual(
                items.filter((item) => item.kind === "episode").map((item) => item.seriesId),
                ["201", "201", "201"],
              );
              assert.deepStrictEqual(items.find((item) => item.kind === "series")?.paths, [
                "/data/shows/Fixture Show (2021)",
              ]);

              const [owner, bob] = states;

              assert.deepStrictEqual(
                owner?.[1].map((state) => [
                  state.itemId,
                  state.played,
                  state.positionMs,
                  state.playCount,
                ]),
                [
                  ["101", true, 0, 2],
                  ["102", false, 6000, 0],
                  ["301", true, 0, 1],
                ],
              );
              assert.deepStrictEqual(
                bob?.[1].map((state) => [state.itemId, state.playCount, state.lastPlayedAt]),
                [
                  ["301", 2, 1_790_700_000_000],
                  ["102", 1, 1_790_650_000_000],
                ],
              );
              assert.deepStrictEqual(collections, [
                {
                  collectionId: "901",
                  name: "Fixture Box",
                  sortName: null,
                  itemIds: ["101", "104"],
                },
              ]);
              assert.isTrue(server.requests.every((request) => request.method === "GET"));
            }),
        ),
    );

    it.effect("reports why it could not connect", () =>
      withServer(
        () => startPlexFixture(),
        (server) =>
          Effect.gen(function* () {
            assert.strictEqual(yield* refusal("plex", server.url, token("wrong")), "auth_failed");

            assert.strictEqual(
              yield* refusal("plex", server.url, token(FIXTURE_SHARED_TOKEN)),
              "not_admin",
            );

            assert.strictEqual(
              yield* refusal("plex", server.url, password("admin", "secret")),
              "auth_failed",
            );
          }),
      ),
    );

    it.effect("refuses servers without provider IDs in listings", () =>
      withServer(
        () =>
          startPlexFixture({
            "owner|GET /identity": {
              status: 200,
              body: { MediaContainer: { machineIdentifier: "old", version: "1.19.5.3112" } },
            },
          }),
        (server) =>
          refusal("plex", server.url, token(FIXTURE_PLEX_TOKEN)).pipe(
            Effect.map((found) => assert.strictEqual(found, "version_unsupported")),
          ),
      ),
    );
  },
);
