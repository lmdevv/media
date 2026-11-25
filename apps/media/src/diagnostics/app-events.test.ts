import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { LogRecord, MAX_APP_TIMING_MS } from "@media/contracts/diagnostics";
import { Unauthenticated } from "@media/contracts/errors";
import { UserId } from "@media/contracts/ids";
import {
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";

import * as CoreCallers from "../core/core-callers.ts";
import { serve } from "../http/http-server.ts";
import * as LogsRoutes from "../logging/logs-routes.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { redactedLine } from "../observability.ts";
import * as AppEvents from "./app-events.ts";

const ADMIN_TOKEN = "admin-token";

const MEMBER_PREFIX = "member-";

/** The admin, and a member named by every `member-<id>` token, so each test has its own budget. */
const callerOf = (token: string): Option.Option<CoreCallers.Caller> => {
  if (token === ADMIN_TOKEN) {
    return Option.some({
      userId: UserId.make("user_admin"),
      role: "admin",
      scopes: ["account", "admin"],
    });
  }

  return token.startsWith(MEMBER_PREFIX)
    ? Option.some({
        userId: UserId.make(`user_${token.slice(MEMBER_PREFIX.length)}`),
        role: "member",
        scopes: ["account"],
      })
    : Option.none();
};

const authLayer = Layer.succeed(
  CoreCallers.Service,
  CoreCallers.Service.of({
    authorize: (bearer) =>
      Effect.fromOption(callerOf(Redacted.value(bearer))).pipe(
        Effect.mapError(() => new Unauthenticated({ message: "Unknown token" })),
      ),
  }),
);

class Server extends Context.Service<Server, { readonly baseUrl: string }>()(
  "test/AppEventsServer",
) {}

const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-app-events-" });

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
    });

    const retainedLogger = Logger.make((options) => {
      logs.append(redactedLine.log(options), options.date.getTime());
    });

    const routes = serve(Layer.mergeAll(LogsRoutes.layer, AppEvents.layer)).pipe(
      Layer.provide(Layer.mergeAll(authLayer, Layer.succeed(RetainedLogs.Service, logs))),
      Layer.provide(Logger.layer([retainedLogger])),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const ready = Layer.effect(
      Server,
      HttpServer.addressFormattedWith((baseUrl) => Effect.succeed(Server.of({ baseUrl }))),
    );

    return ready.pipe(Layer.provideMerge(routes));
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));

const post = (path: string, token: Option.Option<string>, body: Schema.Json) =>
  Effect.gen(function* () {
    const { baseUrl } = yield* Server;
    const headers = new Headers({ "content-type": "application/json" });

    if (Option.isSome(token)) headers.set("authorization", `Bearer ${token.value}`);

    return yield* Effect.promise(() =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  });

const unique = () => crypto.randomUUID().slice(0, 8);

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(LogRecord));

const failureOf = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.map(Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))),
  );

const grep = (text: string) =>
  Effect.gen(function* () {
    const response = yield* post("/api/logs", Option.some(ADMIN_TOKEN), { grep: text });
    const body = yield* Effect.promise(() => response.text());

    return body
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeRecord(line));
  });

const batch = (events: ReadonlyArray<Schema.Json>) => ({
  platform: "ios",
  app: "music",
  release: "0.9.0",
  development: false,
  events,
});

const launched = (firstFrameMs: number) => ({
  ageMs: 0,
  event: {
    _tag: "Launched",
    kind: "cold",
    firstFrameMs,
    home: { ms: firstFrameMs + 400, source: "network" },
  },
});

layer(serverLayer, { timeout: 30_000 })("app events", (it) => {
  it.effect("write a signed-in account's launches, screen opens, and errors to the log", () =>
    Effect.gen(function* () {
      const id = unique();
      const albumId = `album_${id}`;
      const now = yield* Clock.currentTimeMillis;

      const response = yield* post(
        "/api/app-events",
        Option.some(`member-${id}`),
        batch([
          launched(812),
          {
            ageMs: 2000,
            event: { _tag: "ScreenOpened", screen: "album", id: albumId, durationMs: 345 },
          },
          {
            ageMs: 90_000,
            event: {
              _tag: "ErrorCaught",
              kind: "uncaught",
              fatal: true,
              route: "/album/[id]",
              name: "TypeError",
              message: `undefined is not a function ${id}`,
              stack: "TypeError: undefined is not a function\n    at Album (main.jsbundle:1:2)",
            },
          },
        ]),
      );

      assert.strictEqual(response.status, 204);

      const records = yield* grep(`user_${id}`);
      const byMessage = new Map(records.map((record) => [record.message, record]));
      const launch = byMessage.get("App.launched");
      const open = byMessage.get("App.screenOpened");
      const error = byMessage.get("Client.error");

      assert.strictEqual(records.length, 3);
      assert.strictEqual(launch?.level, "INFO");

      assert.deepInclude(launch?.annotations, {
        source: "app",
        userId: `user_${id}`,
        platform: "ios",
        app: "music",
        appVersion: "0.9.0",
        development: false,
        launch: "cold",
        firstFrameMs: 812,
        homeMs: 1212,
        homeSource: "network",
      });

      assert.deepInclude(open?.annotations, { screen: "album", recordId: albumId, openMs: 345 });
      assert.strictEqual(open?.annotations["occurredAt"], new Date(now - 2000).toISOString());
      assert.strictEqual(error?.level, "ERROR");

      assert.deepInclude(error?.annotations, {
        source: "client",
        kind: "uncaught",
        fatal: true,
        route: "/album/[id]",
        errorName: "TypeError",
        failedRequestId: null,
      });

      assert.strictEqual(error?.annotations["occurredAt"], new Date(now - 90_000).toISOString());
    }),
  );

  it.effect("write a non-fatal error at WARN and a launch that never reached Home without it", () =>
    Effect.gen(function* () {
      const id = unique();

      yield* post(
        "/api/app-events",
        Option.some(`member-${id}`),
        batch([
          { ageMs: 0, event: { _tag: "Launched", kind: "warm", firstFrameMs: 40 } },
          {
            ageMs: 0,
            event: {
              _tag: "ErrorCaught",
              kind: "unhandled-rejection",
              fatal: false,
              route: "/",
              name: "Error",
              message: "a rejection nobody handled",
            },
          },
        ]),
      );

      const records = yield* grep(`user_${id}`);
      const launch = records.find((record) => record.message === "App.launched");
      const error = records.find((record) => record.message === "Client.error");

      assert.deepInclude(launch?.annotations, { launch: "warm", homeMs: null, homeSource: null });
      assert.strictEqual(error?.level, "WARN");
      assert.strictEqual(error?.annotations["stack"], null);
    }),
  );

  it.effect("refuse a caller that is not signed in", () =>
    Effect.gen(function* () {
      const anonymous = yield* post("/api/app-events", Option.none(), batch([launched(1)]));

      const unknown = yield* post(
        "/api/app-events",
        Option.some("revoked-token"),
        batch([launched(1)]),
      );

      assert.strictEqual(anonymous.status, 401);
      assert.strictEqual(unknown.status, 401);
    }),
  );

  it.effect("reject a record's name in place of its id, and a duration past its bound", () =>
    Effect.gen(function* () {
      const token = Option.some(`member-${unique()}`);

      const named = yield* post(
        "/api/app-events",
        token,
        batch([
          {
            ageMs: 0,
            event: { _tag: "ScreenOpened", screen: "title", id: "Big Buck Bunny", durationMs: 9 },
          },
        ]),
      );

      const slow = yield* post("/api/app-events", token, batch([launched(MAX_APP_TIMING_MS + 1)]));

      assert.strictEqual(named.status, 400);
      assert.strictEqual((yield* failureOf(named)).code, "invalid_args");
      assert.strictEqual(slow.status, 400);
    }),
  );

  it.effect("count each account's events, so a stuck reporter cannot flood the log", () =>
    Effect.gen(function* () {
      const id = unique();
      const fifty = Array.from({ length: 50 }, (_, index) => launched(index));
      const statuses: Array<number> = [];

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = yield* post("/api/app-events", Option.some(`member-${id}`), batch(fifty));

        statuses.push(response.status);

        if (response.status === 429) {
          assert.isNotNull(response.headers.get("retry-after"));
          assert.strictEqual((yield* failureOf(response)).code, "rate_limited");
          break;
        }
      }

      const written = yield* grep(`user_${id}`);

      assert.deepStrictEqual(statuses, [204, 204, 204, 204, 429]);
      assert.strictEqual(written.length, 200);

      yield* TestClock.adjust(Duration.seconds(30));

      const summaries = yield* grep("AppEvents.suppressed");
      const mine = summaries.find((record) => record.annotations["userId"] === `user_${id}`);

      assert.strictEqual(mine?.annotations["events"], 50);
    }),
  );
});
