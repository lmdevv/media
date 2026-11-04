import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { MigrationCredentials } from "@media/contracts/models/migration";
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { openSource } from "../src/migration/sources.ts";
import { startJellyfin } from "../src/migration/testing/jellyfin-docker.ts";
import {
  FIXTURE_API_KEY,
  fixturePassword,
  jellyfinIdentity,
} from "../src/migration/testing/jellyfin-fixture.ts";
import { startRecorder } from "../src/migration/testing/recorded-server.ts";

const SignIn = Schema.fromJsonString(Schema.Struct({ Username: Schema.String }));

const SignedIn = Schema.Struct({ AccessToken: Schema.String });

const OUTPUT = new URL("../src/migration/fixtures/jellyfin.json", import.meta.url).pathname;

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "movies-jellyfin-record-" });
  const server = yield* startJellyfin(workspace);

  const recorder = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startRecorder(
        server.url,
        jellyfinIdentity,
        new Map([[server.apiKey, "apikey"]]),
        (path, requestBody, responseBody) => {
          if (path !== "/Users/AuthenticateByName") return null;
          const request = Schema.decodeOption(SignIn)(requestBody);
          const response = Option.flatMap(responseBody, Schema.decodeUnknownOption(SignedIn));

          return Option.isSome(request) && Option.isSome(response)
            ? { user: request.value.Username, token: response.value.AccessToken }
            : null;
        },
        new Map([
          [server.passwords.admin, fixturePassword("admin")],
          [server.passwords.bob, fixturePassword("bob")],
        ]),
      ),
    ),
    (running) => Effect.promise(running.close),
  );

  const readAll = (credentials: MigrationCredentials) =>
    openSource("jellyfin", { url: recorder.url, credentials }).pipe(
      Effect.flatMap((session) =>
        Effect.all([
          session.items,
          session.collections,
          Effect.forEach(session.users, (user) => session.userStates(user)),
        ]),
      ),
      Effect.ignore,
    );

  yield* Effect.forEach(
    [
      { kind: "token" as const, token: Redacted.make(server.apiKey) },
      {
        kind: "password" as const,
        username: "admin",
        password: Redacted.make(server.passwords.admin),
      },
      { kind: "password" as const, username: "bob", password: Redacted.make(server.passwords.bob) },
      { kind: "password" as const, username: "admin", password: Redacted.make("wrong") },
    ],
    readAll,
  );

  const text = JSON.stringify(
    { version: server.version, ids: server.ids, recordings: recorder.recordings() },
    null,
    2,
  )
    .replaceAll(server.apiKey, FIXTURE_API_KEY)
    .replaceAll(server.url, "http://jellyfin-fixture:8096");

  yield* fs.writeFileString(OUTPUT, `${text}\n`);
  yield* Effect.logInfo(`Recorded Jellyfin ${server.version}`);
});

const main = Effect.gen(function* () {
  const platform = yield* Layer.build(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer));

  yield* record.pipe(Effect.provideContext(platform));
});

NodeRuntime.runMain(Effect.scoped(main));
