import { assert, describe, layer } from "@effect/vitest";
import type { LogRecord } from "@media/contracts/diagnostics";
import { RequestId } from "@media/contracts/request-id";
import { Effect, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const urlOf = (record: LogRecord): string => {
  const url = record.annotations["http.url"];

  return Predicate.isString(url) ? url : "";
};

const LONG_NAME = "x".repeat(15_000);

const isRequestId = Schema.is(RequestId);

const UNKNOWN_STREAM = "AAAAAAAAAAAAAAAAAAAAAA";

const flood = Effect.gen(function* () {
  const server = yield* MediaTestServer.Service;
  const client = yield* HttpClient.HttpClient;

  const statuses = yield* Effect.forEach(
    [
      `/media/hls/${LONG_NAME}/1/index.m3u8?token=not-a-token`,
      `/media/file/${LONG_NAME}?token=not-a-token`,
      `/no-such-route/${LONG_NAME}`,
    ],
    (path) =>
      client
        .execute(HttpClientRequest.get(`${server.baseUrl}${path}`))
        .pipe(Effect.map((response) => response.status)),
    { concurrency: "unbounded" },
  );

  assert.isTrue(statuses.every((status) => status >= 400 && status < 500));

  return server.logged();
});

const send = Effect.fn(function* (path: string, requestId?: string) {
  const server = yield* MediaTestServer.Service;
  const client = yield* HttpClient.HttpClient;

  const response = yield* client
    .execute(
      HttpClientRequest.get(`${server.baseUrl}${path}`, {
        headers: requestId === undefined ? {} : { "x-request-id": requestId },
      }),
    )
    .pipe(Effect.orDie);

  return { status: response.status, requestId: response.headers["x-request-id"] ?? "" };
});

const loggedUntil = (found: (logged: ReadonlyArray<LogRecord>) => boolean) =>
  Effect.gen(function* () {
    const server = yield* MediaTestServer.Service;

    return yield* Effect.sync(() => server.logged()).pipe(
      Effect.repeat({ until: found, schedule: Schedule.spaced(20) }),
      Effect.timeout("5 seconds"),
      Effect.orDie,
    );
  });

const sendLogged = (path: string, requestId: string) =>
  Effect.gen(function* () {
    const server = yield* MediaTestServer.Service;
    const before = server.logged().length;
    const answer = yield* send(path, requestId);

    const during = (yield* loggedUntil((records) =>
      records.slice(before).some((record) => record.message === "HttpServer.response"),
    )).slice(before);

    assert.isTrue(isRequestId(answer.requestId));
    assert.deepStrictEqual(
      during.filter((record) => record.annotations["requestId"] !== answer.requestId),
      [],
    );

    return { refused: answer, during };
  });

describe("request log", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect("keeps nothing a caller without a token sends at the default level", () =>
      Effect.gen(function* () {
        const logged = yield* flood;

        assert.deepStrictEqual(
          logged.filter((record) => JSON.stringify(record).includes(LONG_NAME.slice(0, 200))),
          [],
        );
        assert.deepStrictEqual(
          logged.filter((record) => record.annotations["http.url"] !== undefined),
          [],
        );
      }),
    );

    it.effect("answers every request, refused ones too, with its own request id", () =>
      Effect.gen(function* () {
        const unrouted = yield* send("/no-such-route");
        const refused = yield* send(`/media/direct/file_1?token=v1.forged.token`);

        assert.strictEqual(unrouted.status, 404);
        assert.strictEqual(refused.status, 401);
        assert.isTrue(isRequestId(unrouted.requestId));
        assert.isTrue(isRequestId(refused.requestId));
        assert.notStrictEqual(unrouted.requestId, refused.requestId);
      }),
    );

    it.effect("answers with an id of its own whatever id the caller sent", () =>
      Effect.gen(function* () {
        const first = yield* send("/no-such-route", "web_42-a");
        const again = yield* send("/no-such-route", "web_42-a");

        assert.isTrue(isRequestId(first.requestId));
        assert.isTrue(isRequestId(again.requestId));
        assert.notStrictEqual(first.requestId, again.requestId);
      }),
    );

    it.effect("lets a browser send a request id across origins", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const client = yield* HttpClient.HttpClient;

        const preflight = yield* client
          .execute(
            HttpClientRequest.options(`${server.baseUrl}/api/health`, {
              headers: {
                origin: "http://web.example",
                "access-control-request-method": "GET",
                "access-control-request-headers": "x-request-id",
              },
            }),
          )
          .pipe(Effect.orDie);

        assert.include(
          (preflight.headers["access-control-allow-headers"] ?? "")
            .split(",")
            .map((name) => name.trim()),
          "x-request-id",
        );
      }),
    );

    it.effect("tags the warning of a member's failing request with its request id", () =>
      Effect.gen(function* () {
        const token = signTestToken({ fid: "file_1", sid: "tagged" });
        const failed = yield* send(`/media/hls/${UNKNOWN_STREAM}/1/junk?token=${token}`);

        assert.strictEqual(failed.status, 404);

        const logged = yield* loggedUntil((records) =>
          records.some((record) => record.annotations["sessionId"] === "tagged"),
        );

        const warning = logged.find((record) => record.annotations["sessionId"] === "tagged");

        assert.strictEqual(warning?.message, "MediaRoutes.request_failed");
        assert.strictEqual(warning?.level, "WARN");
        assert.strictEqual(warning?.annotations["requestId"], failed.requestId);
      }),
    );
  });

  layer(MediaTestServer.layer({ LOG_LEVEL: "debug" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect("logs each response at DEBUG with its path cut short and no query", () =>
      Effect.gen(function* () {
        const logged = yield* flood;

        const access = logged.filter((record) => urlOf(record) !== "");

        assert.isAtLeast(access.length, 3);

        for (const record of access) {
          const url = urlOf(record);

          assert.strictEqual(record.level, "DEBUG");
          assert.isAtMost(url.length, 129);
          assert.notInclude(url, "?");
          assert.isNumber(record.annotations["http.status"]);
          assert.isNumber(record.annotations["elapsedMs"]);
        }

        assert.isTrue(access.some((record) => urlOf(record).startsWith("/media/hls/xxxx")));
      }),
    );

    it.effect("tags every record of a request with its id and the caller's plain id apart", () =>
      Effect.gen(function* () {
        const path = `/media/hls/${UNKNOWN_STREAM}/1/0.m4s`;

        const { refused, during } = yield* sendLogged(
          `${path}?token=v1.forged.token`,
          "trace-me-1",
        );

        assert.strictEqual(refused.status, 401);
        assert.includeMembers(
          during.map((record) => record.message),
          ["MediaRoutes.request_failed", "HttpServer.response"],
        );
        assert.deepStrictEqual(
          during.filter((record) => record.annotations["clientRequestId"] !== "trace-me-1"),
          [],
        );
      }),
    );

    it.effect(
      "keeps no caller id that the log would redact, that is not one plain word, or that looks like a request id",
      () =>
        Effect.gen(function* () {
          for (const unsafe of [
            "mk_abcdefghijklmnop",
            "x".repeat(65),
            "two words",
            "id;drop",
            "",
            "0b6f3c1e-5d2a-4e8f-9a7b-3c4d5e6f7a81",
            "0B6F3C1E-5D2A-1E8F-0A7B-3C4D5E6F7A81",
          ]) {
            const { during } = yield* sendLogged("/no-such-route", unsafe);

            assert.deepStrictEqual(
              during.filter((record) => record.annotations["clientRequestId"] !== undefined),
              [],
            );
          }
        }),
    );

    it.effect("keeps no invite code from the path of an invite link, in any case", () =>
      Effect.gen(function* () {
        const code = "InviteCodeQ7mZ2xLp";

        yield* send(`/invite/${code}`);
        yield* send(`/INVITE/${code}`);
        yield* send(`//invite/${code}`);

        const logged = yield* loggedUntil((records) =>
          ["/invite/<redacted>", "/INVITE/<redacted>"].every((url) =>
            records.some((record) => urlOf(record) === url),
          ),
        );

        assert.deepStrictEqual(
          logged.filter((record) => JSON.stringify(record).includes(code)),
          [],
        );
      }),
    );
  });
});
