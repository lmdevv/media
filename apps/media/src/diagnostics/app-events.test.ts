import { createServer, request } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  AppEventsRequest,
  LogRecord,
  MAX_APP_EVENTS,
  MAX_APP_EVENTS_BYTES,
  MAX_APP_TIMING_MS,
  MAX_ERROR_FRAMES,
} from "@media/contracts/diagnostics";
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
import { MAX_REQUEST_BODY_BYTES } from "../http/hardening.ts";
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

const launched = (firstScreenVisibleMs: number) => ({
  ageMs: 0,
  event: {
    _tag: "Launched",
    firstScreenVisibleMs,
    homeContent: { ms: firstScreenVisibleMs + 400, source: "network" },
  },
});

const postRaw = (body: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const { baseUrl } = yield* Server;

    return yield* Effect.promise(() =>
      fetch(`${baseUrl}/api/app-events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  });

/** The status the route answers a body sent in chunks, with no declared length. */
const postChunked = (body: string, token: string) =>
  Effect.gen(function* () {
    const { baseUrl } = yield* Server;

    return yield* Effect.callback<number>((resume) => {
      const outgoing = request(`${baseUrl}/api/app-events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      });

      outgoing.on("response", (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      });
      outgoing.on("error", () => {
        resume(Effect.succeed(0));
      });

      for (let at = 0; at < body.length; at += 4096) outgoing.write(body.slice(at, at + 4096));
      outgoing.end();
    });
  });

/** The largest batch the schema accepts: every event an error with every field at its bound. */
const largestBatch = (): AppEventsRequest => ({
  platform: "ios",
  app: "movies",
  release: "x".repeat(64),
  development: false,
  events: Array.from({ length: MAX_APP_EVENTS }, () => ({
    ageMs: 2_592_000_000,
    event: {
      _tag: "ErrorCaught",
      kind: "unhandled-rejection",
      fatal: false,
      route: `/${"a".repeat(255)}`,
      errorClass: `E${"x".repeat(63)}`,
      frames: Array.from({ length: MAX_ERROR_FRAMES }, () => ({
        fn: "f".repeat(64),
        file: `${"b".repeat(48)}.jsbundle`,
        line: 100_000_000,
        column: 100_000_000,
      })),
      requestId: "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d",
    },
  })),
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
            event: {
              _tag: "ScreenOpened",
              screen: "album",
              id: albumId,
              cache: "fetched",
              contentVisibleMs: 345,
            },
          },
          {
            ageMs: 90_000,
            event: {
              _tag: "ErrorCaught",
              kind: "uncaught",
              fatal: true,
              route: "/album/[id]",
              errorClass: "TypeError",
              frames: [{ fn: "Album", file: "main.jsbundle", line: 1, column: 2 }],
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
        firstScreenVisibleMs: 812,
        homeContentVisibleMs: 1212,
        homeSource: "network",
      });

      assert.deepInclude(open?.annotations, {
        screen: "album",
        recordId: albumId,
        cache: "fetched",
        contentVisibleMs: 345,
      });
      assert.strictEqual(open?.annotations["occurredAt"], new Date(now - 2000).toISOString());
      assert.strictEqual(error?.level, "ERROR");

      assert.deepInclude(error?.annotations, {
        source: "client",
        kind: "uncaught",
        fatal: true,
        route: "/album/[id]",
        errorClass: "TypeError",
        failedRequestId: null,
      });
      assert.deepStrictEqual(error?.annotations["frames"], ["Album main.jsbundle:1:2"]);

      assert.strictEqual(error?.annotations["occurredAt"], new Date(now - 90_000).toISOString());
    }),
  );

  it.effect("write a non-fatal error at WARN and a launch whose Home showed no content", () =>
    Effect.gen(function* () {
      const id = unique();

      yield* post(
        "/api/app-events",
        Option.some(`member-${id}`),
        batch([
          { ageMs: 0, event: { _tag: "Launched", firstScreenVisibleMs: 940 } },
          {
            ageMs: 0,
            event: {
              _tag: "ErrorCaught",
              kind: "unhandled-rejection",
              fatal: false,
              route: "/",
              errorClass: "Error",
              frames: [],
            },
          },
        ]),
      );

      const records = yield* grep(`user_${id}`);
      const launch = records.find((record) => record.message === "App.launched");
      const error = records.find((record) => record.message === "Client.error");

      assert.deepInclude(launch?.annotations, {
        firstScreenVisibleMs: 940,
        homeContentVisibleMs: null,
        homeSource: null,
      });
      assert.strictEqual(error?.level, "WARN");
    }),
  );

  it.effect("refuse an error report with text in place of a route pattern, class, or frame", () =>
    Effect.gen(function* () {
      const token = Option.some(`member-${unique()}`);

      const error = (fields: Record<string, Schema.Json>) =>
        post(
          "/api/app-events",
          token,
          batch([
            {
              ageMs: 0,
              event: {
                _tag: "ErrorCaught",
                kind: "uncaught",
                fatal: false,
                route: "/",
                errorClass: "Error",
                frames: [],
                ...fields,
              },
            },
          ]),
        );

      const refused = [
        yield* error({ route: "/album/Lucía García" }),
        yield* error({ errorClass: "Lucía can't play Sintel" }),
        yield* error({
          frames: [{ fn: "f", file: "/Users/lucia/Sintel.mkv", line: 1, column: 1 }],
        }),
        yield* error({ message: "Lucía can't play Sintel" }),
      ];

      assert.deepStrictEqual(
        refused.map((response) => response.status),
        [400, 400, 400, 204],
      );

      const records = yield* grep("Lucía");

      assert.deepStrictEqual(records, []);
    }),
  );

  it.effect("refuse a body past the cap, or of no declared length, before reading it", () =>
    Effect.gen(function* () {
      const token = `member-${unique()}`;
      const oversize = `{"pad":"${"a".repeat(MAX_APP_EVENTS_BYTES)}"}`;

      const declared = yield* postRaw(oversize, { authorization: `Bearer ${token}` });

      const streamed = yield* postChunked(oversize, token);

      const largest = JSON.stringify(
        yield* Schema.encodeEffect(Schema.toCodecJson(AppEventsRequest))(largestBatch()),
      );

      const accepted = yield* postRaw(largest, { authorization: `Bearer ${token}` });

      assert.strictEqual(declared.status, 413);
      assert.strictEqual(streamed, 411);
      assert.strictEqual(accepted.status, 204);
      assert.isAtMost(new TextEncoder().encode(largest).length, MAX_APP_EVENTS_BYTES);
      assert.isAtMost(MAX_APP_EVENTS_BYTES, MAX_REQUEST_BODY_BYTES);
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
            event: {
              _tag: "ScreenOpened",
              screen: "title",
              id: "Big Buck Bunny",
              cache: "kept",
              contentVisibleMs: 9,
            },
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
