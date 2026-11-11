import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { DiagnosedSession, PlaybackDiagnostics } from "@media/contracts/diagnostics";
import { Forbidden, Unauthenticated } from "@media/contracts/errors";
import { UserId } from "@media/contracts/ids";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";

import * as CoreCallers from "../core/core-callers.ts";
import { serve } from "../http/http-server.ts";
import * as LogsRoutes from "../logging/logs-routes.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { appendRecord } from "../testing/log-lines.ts";
import * as DiagnosticsRoutes from "./diagnostics-routes.ts";
import { LogEvent } from "./log-events.ts";

const DOMAIN_SCOPES = ["movies:read", "movies:play", "movies:edit"];

const caller = (id: string, role: "admin" | "member"): CoreCallers.Caller => ({
  userId: UserId.make(id),
  role,
  scopes: role === "admin" ? ["account", "admin", ...DOMAIN_SCOPES] : ["account", ...DOMAIN_SCOPES],
});

const CALLERS: ReadonlyMap<string, CoreCallers.Caller> = new Map([
  ["admin-token", caller("user_admin", "admin")],
  ["member-token", caller("user_a", "member")],
  ["other-token", caller("user_b", "member")],
]);

const authLayer = Layer.succeed(
  CoreCallers.Service,
  CoreCallers.Service.of({
    authorize: (bearer, access) => {
      const found = CALLERS.get(Redacted.value(bearer));

      if (found === undefined) {
        return Effect.fail(new Unauthenticated({ message: "Unknown token" }));
      }

      return CoreCallers.holds(found, access)
        ? Effect.succeed(found)
        : Effect.fail(new Forbidden({ message: `This session lacks the ${access} scope` }));
    },
  }),
);

const now = Date.now();

const line = (
  message: string,
  offsetMs: number,
  annotations: Readonly<Record<string, string | number | null>>,
  level = "INFO",
) =>
  JSON.stringify({
    message,
    level,
    timestamp: new Date(now - 60_000 + offsetMs).toISOString(),
    annotations,
    spans: {},
  });

const sessionDPlayer = (
  message: string,
  offsetMs: number,
  annotations: Readonly<Record<string, string | number | boolean | null>>,
) =>
  line(message, offsetMs, {
    sessionId: "session_d",
    userId: "user_a",
    source: "player",
    platform: "web",
    streamId: "s4",
    ...annotations,
  });

const appendMany = (count: number, make: (index: number) => string) =>
  Effect.gen(function* () {
    const { logs } = yield* Server;

    for (let index = 0; index < count; index += 1) appendRecord(logs, make(index));
    yield* logs.flush;
  });

const SEED = [
  line(LogEvent.streamStarted, 0, {
    sessionId: "session_a",
    userId: "user_a",
    streamId: "s1",
    mode: "remux",
  }),
  line(LogEvent.streamEnded, 1000, {
    sessionId: "session_a",
    userId: "user_a",
    streamId: "s1",
    reason: "idle",
  }),
  line(LogEvent.streamStarted, 2000, { sessionId: "session_b", userId: "user_b", mode: "direct" }),
  line("Main.started", 3000, {}),
];

class Server extends Context.Service<
  Server,
  { readonly baseUrl: string; readonly logs: RetainedLogs.Interface; readonly directory: string }
>()("test/DiagnosticsServer") {}

const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "movies-diagnostics-" });

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: Duration.toMillis(Duration.days(14)), maxBytes: 1 << 29 },
    });

    for (const entry of SEED) appendRecord(logs, entry);
    yield* logs.flush;

    const routes = serve(Layer.mergeAll(LogsRoutes.layer, DiagnosticsRoutes.layer)).pipe(
      Layer.provide(Layer.mergeAll(authLayer, Layer.succeed(RetainedLogs.Service, logs))),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const ready = Layer.effect(
      Server,
      HttpServer.addressFormattedWith((baseUrl) =>
        Effect.succeed(Server.of({ baseUrl, logs, directory })),
      ),
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

const ADMIN = Option.some("admin-token");

const MEMBER = Option.some("member-token");

const OTHER = Option.some("other-token");

const text = (response: Response) => Effect.promise(() => response.text());

const decoded = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));

  return (response: Response) => Effect.map(text(response), decode);
};

const failureOf = decoded(Schema.Struct({ code: Schema.String }));

const timelineOf = decoded(Schema.toCodecJson(PlaybackDiagnostics));

const Count020 = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const EpochMillis020 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 864e13 }));

// The timeline schema of the published CLI @lmdevv/movies@0.2.0, frozen: every timeline the
// service serves to a caller that does not ask for measured drift must decode under it.
const PlaybackDiagnostics020 = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  firstSeenAt: EpochMillis020,
  lastSeenAt: EpochMillis020,
  platform: Schema.NullOr(Schema.Literals(["web", "ios"])),
  counts: Schema.Struct({
    streams: Count020,
    stalls: Count020,
    stalledMs: Count020,
    slowSegments: Count020,
    failedRequests: Count020,
    playerErrors: Count020,
    recoveries: Count020,
    slowFragments: Count020,
    droppedFrames: Count020,
  }),
  drift: Schema.Struct({ status: Schema.Literal("not-measured"), reason: Schema.String }),
  missing: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      at: EpochMillis020,
      source: Schema.Literals(["server", "player"]),
      kind: Schema.Literals([
        "stream-started",
        "stream-moved",
        "stream-ended",
        "mode-changed",
        "encoder-failed",
        "slow-segment",
        "request-failed",
        "player-attached",
        "startup",
        "buffering-started",
        "buffering-ended",
        "player-error",
        "dropped-frames",
        "slow-fragment",
        "recovery",
      ]),
      level: Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]),
      streamId: Schema.NullOr(Schema.String),
      summary: Schema.String,
      details: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
});

const timeline020Of = decoded(Schema.toCodecJson(PlaybackDiagnostics020));

const sessionIdsOf = (response: Response) =>
  Effect.map(decoded(Schema.toCodecJson(Schema.Array(DiagnosedSession)))(response), (sessions) =>
    sessions.map((session) => session.sessionId),
  );

const messageOf = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

layer(serverLayer, { timeout: 30_000 })("log and diagnostics routes", (it) => {
  it.effect("serve the retained log to admins as NDJSON", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/logs", ADMIN, {});
      const lines = (yield* text(response)).trim().split("\n");

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("content-type"), "application/x-ndjson");
      assert.strictEqual(response.headers.get("x-movies-log-truncated"), "false");
      assert.deepStrictEqual(lines, SEED);
    }),
  );

  it.effect("refuse the log to members and to callers without a token", () =>
    Effect.gen(function* () {
      const member = yield* post("/api/logs", MEMBER, {});
      const anonymous = yield* post("/api/logs", Option.none(), {});

      assert.strictEqual(member.status, 403);
      assert.strictEqual((yield* failureOf(member)).code, "forbidden");
      assert.strictEqual(anonymous.status, 401);
    }),
  );

  it.effect("reject a query that is not one", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/logs", ADMIN, { limit: 0 });

      assert.strictEqual(response.status, 400);
      assert.strictEqual((yield* failureOf(response)).code, "invalid_args");
    }),
  );

  it.effect("reject a window that ends before or as it starts", () =>
    Effect.gen(function* () {
      for (const until of [now - 120_000, now - 60_000]) {
        const response = yield* post("/api/logs", ADMIN, { since: now - 60_000, until });

        assert.strictEqual(response.status, 400);
        assert.strictEqual((yield* failureOf(response)).code, "invalid_args");
      }
    }),
  );

  it.effect("follow the log: new matching records arrive as they are written", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      const response = yield* post("/api/logs", ADMIN, {
        sessionId: "session_a",
        follow: true,
      });

      const body = yield* Effect.fromOption(Option.fromNullishOr(response.body)).pipe(Effect.orDie);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let received = "";

      appendRecord(
        logs,
        line(LogEvent.streamStarted, 5000, { sessionId: "session_b", userId: "user_b" }),
      );
      appendRecord(
        logs,
        line(LogEvent.streamMoved, 6000, { sessionId: "session_a", userId: "user_a" }),
      );
      yield* logs.flush;

      while (!received.includes(LogEvent.streamMoved)) {
        const chunk = yield* Effect.promise(() => reader.read());

        if (chunk.done) break;

        if (chunk.value instanceof Uint8Array) received += decoder.decode(chunk.value);
      }

      yield* Effect.promise(() => reader.cancel());

      const messages = received
        .trim()
        .split("\n")
        .map((entry) => messageOf(entry).message);

      assert.deepStrictEqual(messages, [
        LogEvent.streamStarted,
        LogEvent.streamEnded,
        LogEvent.streamMoved,
      ]);
    }),
  );

  it.effect("give a member the timeline of their own session only", () =>
    Effect.gen(function* () {
      const own = yield* post("/api/diagnostics/playback", MEMBER, {
        sessionId: "session_a",
      });

      const others = yield* post("/api/diagnostics/playback", MEMBER, {
        sessionId: "session_b",
      });

      assert.strictEqual(own.status, 200);
      assert.strictEqual((yield* timelineOf(own)).sessionId, "session_a");
      assert.strictEqual(others.status, 404);
      assert.strictEqual((yield* failureOf(others)).code, "not_found");
    }),
  );

  it.effect("give an admin any session's timeline", () =>
    Effect.gen(function* () {
      const response = yield* post("/api/diagnostics/playback", ADMIN, {
        sessionId: "session_b",
      });

      const timeline = yield* timelineOf(response);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(timeline.sessionId, "session_b");
      assert.strictEqual(timeline.drift.status, "not-measured");
    }),
  );

  it.effect("list a member's own sessions and every session for an admin", () =>
    Effect.gen(function* () {
      const member = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", OTHER, {}));
      const admin = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", ADMIN, {}));

      assert.deepStrictEqual(member, ["session_b"]);
      assert.sameMembers(admin, ["session_a", "session_b"]);
    }),
  );

  it.effect("serve measured drift only to callers that ask for it, and decode for 0.2.0", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      for (const entry of [
        line(LogEvent.streamStarted, 7000, {
          sessionId: "session_d",
          userId: "user_a",
          streamId: "s4",
          mode: "remux",
        }),
        sessionDPlayer(LogEvent.playerAttached, 7100, {
          mode: "remux",
          engine: "hls.js",
          audioCodec: "aac",
          audioChannels: 2,
          audioLanguage: "eng",
        }),
        sessionDPlayer(LogEvent.fragmentLoaded, 7200, {
          segment: 0,
          elapsedMs: 120,
          firstByteMs: 40,
          bytes: 100_000,
          index: 0,
          startup: true,
        }),
        sessionDPlayer(LogEvent.startupEnded, 7300, {
          positionSeconds: 0,
          startupMs: 900,
          endedBy: "playing",
          negotiatedMs: 200,
          manifestLoadedMs: 350,
          firstFragmentMs: 600,
          firstFrameMs: 900,
        }),
        sessionDPlayer(LogEvent.recovery, 7400, {
          action: "renew-token",
          reason: "token expiring",
        }),
        sessionDPlayer(LogEvent.driftSampled, 67_300, { samples: 6, medianMs: -12, worstMs: -41 }),
        sessionDPlayer(LogEvent.driftSampled, 127_300, { samples: 6, medianMs: -10, worstMs: -20 }),
        sessionDPlayer(LogEvent.driftSampled, 157_300, { samples: 2, medianMs: -15, worstMs: -16 }),
      ]) {
        appendRecord(logs, entry);
      }

      yield* logs.flush;

      const legacy = yield* timeline020Of(
        yield* post("/api/diagnostics/playback", MEMBER, { sessionId: "session_d" }),
      );

      const current = yield* timelineOf(
        yield* post("/api/diagnostics/playback", MEMBER, {
          sessionId: "session_d",
          measuredDrift: true,
        }),
      );

      assert.strictEqual(legacy.drift.status, "not-measured");
      assert.include(legacy.drift.reason, "14 times: median -12 ms, worst -41 ms");
      assert.deepStrictEqual(
        legacy.entries.map((entry) => entry.kind),
        ["stream-started", "player-attached", "startup", "recovery"],
      );
      assert.strictEqual(legacy.counts.recoveries, 0);
      assert.deepStrictEqual(current.drift, {
        status: "measured",
        method: "video-frame-vs-media-clock",
        samples: 14,
        medianMs: -12,
        worstMs: -41,
      });
    }),
  );

  it.effect("keep a long session's start in its timeline, past its debug records", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      appendRecord(
        logs,
        line(LogEvent.streamStarted, 4000, { sessionId: "session_c", userId: "user_a" }),
      );
      yield* appendMany(5001, (index) =>
        line(
          LogEvent.segmentServed,
          4001 + index,
          { sessionId: "session_c", userId: "user_a", segment: String(index) },
          "DEBUG",
        ),
      );

      const timeline = yield* timelineOf(
        yield* post("/api/diagnostics/playback", MEMBER, { sessionId: "session_c" }),
      );

      assert.include(
        timeline.entries.map((entry) => entry.kind),
        "stream-started",
      );
    }),
  );

  it.effect("list a member's sessions past other accounts' busy traffic", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      appendRecord(
        logs,
        line(LogEvent.streamStarted, 5000, { sessionId: "session_f", userId: "user_a" }),
      );
      yield* appendMany(5001, (index) =>
        line(LogEvent.streamStarted, 5001 + index, {
          sessionId: `busy_${String(index)}`,
          userId: "user_b",
        }),
      );

      const member = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", MEMBER, {}));

      assert.isTrue(member.some((sessionId) => sessionId === "session_f"));
    }),
  );

  it.effect("list a member's sessions past their own error reports", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;

      appendRecord(
        logs,
        line(LogEvent.streamStarted, 5000, { sessionId: "session_g", userId: "user_a" }),
      );
      yield* appendMany(5001, (index) =>
        line(
          "Client.error",
          5001 + index,
          { source: "client", userId: "user_a", errorMessage: `crash ${String(index)}` },
          "WARN",
        ),
      );

      const member = yield* sessionIdsOf(yield* post("/api/diagnostics/sessions", MEMBER, {}));

      assert.isTrue(member.some((sessionId) => sessionId === "session_g"));
    }),
  );
});

layer(serverLayer, { timeout: 30_000 })("diagnostics read limit", (it) => {
  it.effect("limit how often one account reads diagnostics", () =>
    Effect.gen(function* () {
      const answers = yield* Effect.forEach(Array.from({ length: 30 }), () =>
        post("/api/diagnostics/sessions", OTHER, {}),
      );

      const limited = yield* Effect.fromOption(
        Option.fromNullishOr(answers.find((answer) => answer.status === 429)),
      ).pipe(Effect.orDie);

      assert.strictEqual((yield* failureOf(limited)).code, "rate_limited");
      assert.match(limited.headers.get("retry-after") ?? "", /^[1-9]\d*$/u);
    }),
  );
});

layer(serverLayer, { timeout: 30_000 })("log routes as the service shuts down", (it) => {
  it.effect("end a followed log at once", () =>
    Effect.gen(function* () {
      const { logs } = yield* Server;
      const response = yield* post("/api/logs", ADMIN, { follow: true });
      const body = yield* Effect.forkChild(text(response));

      yield* logs.close;

      const received = yield* Fiber.join(body).pipe(Effect.timeout("2 seconds"));

      assert.deepStrictEqual(received.trim().split("\n"), SEED);
    }),
  );
});

layer(serverLayer, { timeout: 30_000 })("log routes without a log folder", (it) => {
  it.effect("say since when the retained log could not be read", () =>
    Effect.gen(function* () {
      const { directory } = yield* Server;
      const fs = yield* FileSystem.FileSystem;

      yield* fs.remove(directory, { recursive: true });
      yield* fs.writeFileString(directory, "");

      const response = yield* post("/api/logs", ADMIN, {});

      assert.strictEqual(response.status, 200);
      assert.isFalse(
        Number.isNaN(Date.parse(response.headers.get("x-movies-log-unavailable-since") ?? "")),
      );
    }),
  );
});
