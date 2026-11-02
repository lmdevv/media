import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { CLIENT_ERROR_LIMITS, LogRecord } from "@movies/contracts/diagnostics";
import { Forbidden, Unauthenticated } from "@movies/contracts/errors";
import { AuthSessionId, UserId } from "@movies/contracts/ids";
import type { Viewer } from "@movies/contracts/models/account";
import { type Role, roleScopes } from "@movies/contracts/scopes";
import { EpochMillis } from "@movies/contracts/units";
import {
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

import * as ViewerAuth from "../convex/viewer-auth.ts";
import { serve } from "../http/http-server.ts";
import * as LogsRoutes from "../logging/logs-routes.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { redactedLine } from "../observability.ts";
import * as ClientErrors from "./client-errors.ts";

const viewer = (id: string, role: Role): Viewer => ({
  user: {
    id: UserId.make(id),
    email: `${id}@example.test`,
    name: id,
    role,
    disabled: false,
    createdAt: EpochMillis.make(0),
  },
  sessionId: AuthSessionId.make(`auth_${id}`),
  sessionKind: "password",
  scopes: roleScopes(role),
});

const ADMIN_TOKEN = "admin-token";

const MEMBER_PREFIX = "member-";

/** The admin, and a member named by every `member-<id>` token, so each test has its own budget. */
const viewerOf = (token: string): Option.Option<Viewer> => {
  if (token === ADMIN_TOKEN) return Option.some(viewer("user_admin", "admin"));

  return token.startsWith(MEMBER_PREFIX)
    ? Option.some(viewer(`user_${token.slice(MEMBER_PREFIX.length)}`, "member"))
    : Option.none();
};

const authorized = { count: 0 };

const authLayer = Layer.succeed(
  ViewerAuth.Service,
  ViewerAuth.Service.of({
    authorize: (bearer, access) => {
      authorized.count += 1;
      const known = viewerOf(Redacted.value(bearer));

      if (Option.isNone(known)) {
        return Effect.fail(new Unauthenticated({ message: "Unknown token" }));
      }

      const found = known.value;

      return access === "authenticated" || found.scopes.some((scope) => scope === access)
        ? Effect.succeed(found)
        : Effect.fail(new Forbidden({ message: `This session lacks the ${access} scope` }));
    },
  }),
);

class Server extends Context.Service<Server, { readonly baseUrl: string }>()(
  "test/ClientErrorsServer",
) {}

const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-client-errors-" });

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
    });

    const retainedLogger = Logger.make((options) => {
      logs.append(redactedLine.log(options), options.date.getTime());
    });

    const routes = serve(Layer.mergeAll(LogsRoutes.layer, ClientErrors.layer)).pipe(
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

type Body = Readonly<Record<string, string | number | boolean>>;

const post = (path: string, token: Option.Option<string>, body: Body) =>
  Effect.gen(function* () {
    const { baseUrl } = yield* Server;
    const headers = new Headers({ "content-type": "application/json" });

    if (Option.isSome(token)) headers.set("authorization", `Bearer ${token.value}`);

    return yield* Effect.promise(() =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  });

const ADMIN = Option.some(ADMIN_TOKEN);

const unique = () => crypto.randomUUID().slice(0, 8);

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(LogRecord));

const failureOf = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.map(Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))),
  );

const grep = (text: string) =>
  Effect.gen(function* () {
    const response = yield* post("/api/logs", ADMIN, { grep: text });
    const body = yield* Effect.promise(() => response.text());

    return body
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeRecord(line));
  });

const report = {
  platform: "web",
  appVersion: "0.2.0",
  kind: "route",
  route: "/titles/title_1",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'poster')",
  stack: "TypeError: Cannot read properties of undefined\n    at TitlePage (/assets/index.js:1:2)",
  requestId: "0b6f4c2e-8d3a-4f6b-9c1d-2e3f4a5b6c7d",
  sessionId: "session_victim",
};

layer(serverLayer, { timeout: 30_000 })("client error reports", (it) => {
  it.effect("write a signed-in account's report to the retained log at WARN", () =>
    Effect.gen(function* () {
      const id = unique();
      const route = `/titles/${id}`;

      const response = yield* post("/api/client-errors", Option.some(`member-${id}`), {
        ...report,
        route,
      });

      assert.strictEqual(response.status, 204);

      const [record, ...rest] = yield* grep(route);

      assert.strictEqual(rest.length, 0);
      assert.isDefined(record);
      assert.strictEqual(record.level, "WARN");
      assert.strictEqual(record.message, "Client.error");

      assert.deepInclude(record.annotations, {
        source: "client",
        userId: `user_${id}`,
        platform: "web",
        appVersion: "0.2.0",
        kind: "route",
        route,
        errorName: "TypeError",
        errorMessage: report.message,
        stack: report.stack,
        failedRequestId: report.requestId,
        claimedSessionId: "session_victim",
      });
    }),
  );

  it.effect("never name the claimed playback session as the record's own session", () =>
    Effect.gen(function* () {
      const id = unique();

      yield* post("/api/client-errors", Option.some(`member-${id}`), {
        ...report,
        route: `/titles/${id}`,
      });
      const [record] = yield* grep(`/titles/${id}`);

      assert.isDefined(record);
      assert.notProperty(record.annotations, "sessionId");
      assert.strictEqual(record.annotations["claimedSessionId"], "session_victim");
    }),
  );

  it.effect("redact secrets and invite codes from every field", () =>
    Effect.gen(function* () {
      const id = unique();
      const token = `${Buffer.from('{"aud":"media"}').toString("base64url")}.c2lnbmF0dXJl`;

      const response = yield* post("/api/client-errors", Option.some(`member-${id}`), {
        ...report,
        route: "/invite/InviteCodeQ7mZ2xLp",
        message: `fetch ${id} https://movies.example/media/hls/a/1/index.m3u8?token=${token} failed`,
        stack: `Error: at https://movies.example/invite/InviteCodeQ7mZ2xLp\n  Bearer ${token}`,
      });

      assert.strictEqual(response.status, 204);

      const [record] = yield* grep(`fetch ${id}`);
      const line = JSON.stringify(record);

      assert.isDefined(record);
      assert.notInclude(line, "InviteCodeQ7mZ2xLp");
      assert.notInclude(line, token);
      assert.strictEqual(record.annotations["route"], "/invite/<redacted>");
    }),
  );

  it.effect("refuse a caller that is not signed in", () =>
    Effect.gen(function* () {
      const anonymous = yield* post("/api/client-errors", Option.none(), report);
      const unknown = yield* post("/api/client-errors", Option.some("revoked-token"), report);

      assert.strictEqual(anonymous.status, 401);
      assert.strictEqual(unknown.status, 401);
    }),
  );

  it.effect("reject a field past its bound", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/client-errors", Option.some(`member-${unique()}`), {
        ...report,
        stack: "x".repeat(CLIENT_ERROR_LIMITS.stack + 1),
      });

      assert.strictEqual(response.status, 400);
      assert.strictEqual((yield* failureOf(response)).code, "invalid_args");
    }),
  );

  it.effect("limit each account, so a crash loop cannot flood the log", () =>
    Effect.gen(function* () {
      const id = unique();
      const statuses: Array<number> = [];

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = yield* post("/api/client-errors", Option.some(`member-${id}`), {
          ...report,
          route: `/flood/${id}`,
        });

        statuses.push(response.status);

        if (response.status === 429) {
          assert.isNotNull(response.headers.get("retry-after"));
          assert.strictEqual((yield* failureOf(response)).code, "rate_limited");
          break;
        }
      }

      const written = yield* grep(`/flood/${id}`);
      const other = yield* post("/api/client-errors", Option.some(`member-${unique()}`), report);

      assert.strictEqual(statuses.at(-1), 429);
      assert.isAtMost(statuses.length, 21);
      assert.strictEqual(written.length, statuses.length - 1);
      assert.strictEqual(other.status, 204);
    }),
  );
});

const accepted = (responses: ReadonlyArray<Response>) =>
  responses.filter((response) => response.status === 204).length;

layer(serverLayer, { timeout: 30_000 })("client error reports across accounts", (it) => {
  it.effect("cap the reports of every account together, and say how many were left out", () =>
    Effect.gen(function* () {
      const id = unique();
      const responses: Array<Response> = [];

      for (let account = 0; account < 60; account += 1) {
        responses.push(
          yield* post("/api/client-errors", Option.some(`member-${id}x${String(account)}`), {
            ...report,
            route: `/many/${id}`,
          }),
        );
      }

      const refused = responses.filter((response) => response.status === 429);

      assert.isAtLeast(accepted(responses), 1);
      assert.isAtLeast(refused.length, 1);
      assert.strictEqual(responses.at(-1)?.status, 429);
      assert.strictEqual((yield* grep(`/many/${id}`)).length, accepted(responses));

      yield* TestClock.adjust(Duration.seconds(30));

      const summaries = yield* grep("ClientErrors.suppressed");

      const counted = summaries.reduce(
        (sum, record) => sum + Number(record.annotations["reports"] ?? 0),
        0,
      );

      assert.strictEqual(counted, refused.length);
      assert.isTrue(summaries.every((record) => record.level === "WARN"));
    }),
  );
});

layer(serverLayer, { timeout: 30_000 })("client error reports in a flood", (it) => {
  it.effect("refuse a flood before asking Convex who is calling", () =>
    Effect.gen(function* () {
      const statuses: Array<number> = [];

      for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = yield* post("/api/client-errors", Option.some("revoked-token"), report);

        statuses.push(response.status);

        if (response.status === 429) break;
      }

      const before = authorized.count;
      const again = yield* post("/api/client-errors", Option.some("revoked-token"), report);

      assert.strictEqual(statuses.at(-1), 429);
      assert.strictEqual(again.status, 429);
      assert.isNotNull(again.headers.get("retry-after"));
      assert.strictEqual(authorized.count, before);
    }),
  );
});
