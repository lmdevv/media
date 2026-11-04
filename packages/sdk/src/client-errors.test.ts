import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { CLIENT_ERROR_LIMITS } from "@media/contracts/diagnostics";
import { NotFound } from "@media/contracts/errors";
import { PlaybackSessionId } from "@media/contracts/ids";
import { Effect, Layer, Option, Predicate, Redacted } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as ClientErrors from "./client-errors";
import type { ErrorContext } from "./client-errors";
import type { CallError } from "./sdk-errors";
import * as Movies from "./movies";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";
import type { TokenStorageError } from "./token-storage";

interface Received {
  readonly url: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

const received: Array<Received> = [];

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const ACCEPTED: Answer = { status: 204, headers: {}, body: "" };

let answer: Answer = ACCEPTED;

const media = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Array<Buffer> = [];

  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      url: request.url ?? "",
      auth: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
});

let mediaUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => media.listen(0, "127.0.0.1", resolve));
  const address = media.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  mediaUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  media.close();
});

beforeEach(() => {
  received.length = 0;
  answer = ACCEPTED;
});

const NOW = Date.now();

const TOKEN = jwtExpiringAt(NOW + 3_600_000);

const context: ErrorContext = {
  platform: "web",
  appVersion: "0.2.0",
  kind: "route",
  route: "/titles/title_1",
};

const withSdk = <A, E>(
  signedIn: boolean,
  body: (
    signIn: Effect.Effect<void, CallError | TokenStorageError>,
  ) => Effect.Effect<A, E, Movies.Services | TestClock.TestClock | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Layer.build(TestClock.layer());

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const fake = yield* FakeConvex.make;

          const sdk = yield* Layer.build(
            Movies.layer({
              convexUrl: fake.url,
              mediaUrl: Option.some(mediaUrl),
              connection: "http",
            }).pipe(Layer.provide(TokenStorage.layerMemory)),
          );

          const signIn = Effect.gen(function* () {
            yield* fake.reply(
              "auth:signIn",
              Reply.Success({ value: { tokens: { token: TOKEN, refreshToken: "refresh-1" } } }),
            );
            const auth = yield* Auth.Auth;

            yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("movies_key") }));
          }).pipe(Effect.provideContext(sdk));

          return yield* Effect.gen(function* () {
            if (signedIn) yield* signIn;

            return yield* body(signIn);
          }).pipe(Effect.provideContext(sdk));
        }).pipe(Effect.provideContext(clock));
      }),
    ),
  );

const report = (cause: unknown, at: ErrorContext = context) =>
  Effect.flatMap(ClientErrors.ClientErrors, (errors) => errors.report(cause, at));

describe("reportOf", () => {
  it("keeps an error's name, message, and stack", () => {
    const error = new TypeError("Cannot read properties of undefined");

    expect(ClientErrors.reportOf(error, context)).toStrictEqual({
      ...context,
      name: "TypeError",
      message: "Cannot read properties of undefined",
      stack: error.stack,
    });
  });

  it("cuts every text field to its bound", () => {
    const error = new Error("m".repeat(5000));

    error.name = "N".repeat(500);
    error.stack = "s".repeat(10_000);

    const cut = ClientErrors.reportOf(error, {
      ...context,
      appVersion: "v".repeat(100),
      route: `/${"r".repeat(1000)}`,
    });

    expect(cut.name).toHaveLength(CLIENT_ERROR_LIMITS.name);
    expect(cut.message).toHaveLength(CLIENT_ERROR_LIMITS.message);
    expect(cut.stack).toHaveLength(CLIENT_ERROR_LIMITS.stack);
    expect(cut.appVersion).toHaveLength(CLIENT_ERROR_LIMITS.appVersion);
    expect(cut.route).toHaveLength(CLIENT_ERROR_LIMITS.route);
  });

  it("names an SDK error by its tag and keeps the request it failed", () => {
    const requestId = "0b6f4c2e-8d3a-4f6b-9c1d-2e3f4a5b6c7d";

    expect(
      ClientErrors.reportOf(new NotFound({ message: "No such title", requestId }), context),
    ).toMatchObject({ name: "NotFound", message: "No such title", requestId });
  });

  it("describes a thrown value that is not an error", () => {
    expect(ClientErrors.reportOf("offline", { ...context, kind: "unhandled-rejection" })).toEqual({
      ...context,
      kind: "unhandled-rejection",
      name: "NonError",
      message: "offline",
    });
  });

  it("describes a plain object that was thrown as its JSON", () => {
    expect(
      ClientErrors.reportOf({ reason: "offline", attempts: 3 }, { ...context, kind: "uncaught" }),
    ).toMatchObject({ name: "NonError", message: '{"reason":"offline","attempts":3}' });
  });

  it("cuts the JSON of a large thrown object to the message bound", () => {
    const cut = ClientErrors.reportOf({ text: "x".repeat(5000) }, context);

    expect(cut.message).toHaveLength(CLIENT_ERROR_LIMITS.message);
  });

  it("names an error whose name is not text by the fallback", () => {
    const error = new Error("boom");

    Object.defineProperty(error, "name", { value: 42 });

    expect(ClientErrors.reportOf(error, context)).toMatchObject({ name: "NonError" });
  });

  it("leaves out a playback session too long to be one", () => {
    const sessionId = PlaybackSessionId.make("s".repeat(CLIENT_ERROR_LIMITS.sessionId + 1));

    expect(ClientErrors.reportOf(new Error("x"), { ...context, sessionId })).not.toHaveProperty(
      "sessionId",
    );
  });

  it("keeps the playback session the app names", () => {
    const sessionId = PlaybackSessionId.make("session_1");

    expect(ClientErrors.reportOf(new Error("x"), { ...context, sessionId })).toMatchObject({
      sessionId,
    });
  });
});

describe("ClientErrors", () => {
  it("sends a signed-in account's error with its token", () =>
    withSdk(true, () =>
      Effect.gen(function* () {
        yield* report(new TypeError("boom"));

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          url: "/api/client-errors",
          auth: `Bearer ${TOKEN}`,
          body: { ...context, name: "TypeError", message: "boom" },
        });
      }),
    ));

  it("sends nothing while signed out", () =>
    withSdk(false, () =>
      Effect.gen(function* () {
        yield* report(new TypeError("boom"));

        expect(received).toStrictEqual([]);
      }),
    ));

  it("sends an error first seen while signed out once signed in", () =>
    withSdk(false, (signIn) =>
      Effect.gen(function* () {
        yield* report(new TypeError("boom"));
        yield* signIn;
        yield* report(new TypeError("boom"));

        expect(received).toHaveLength(1);
      }),
    ));

  it("sends the same error once within the window, then again after it", () =>
    withSdk(true, () =>
      Effect.gen(function* () {
        yield* report(new TypeError("boom"));
        yield* report(new TypeError("boom"));
        yield* report(new TypeError("boom"), { ...context, kind: "uncaught" });
        yield* report(new TypeError("other"));

        expect(received.map((entry) => entry.body)).toMatchObject([
          { message: "boom", kind: "route" },
          { message: "boom", kind: "uncaught" },
          { message: "other" },
        ]);

        yield* TestClock.adjust(ClientErrors.REPEAT_WINDOW_MS);
        yield* report(new TypeError("boom"));

        expect(received).toHaveLength(4);
      }),
    ));

  it("keeps a repeat out of the window even when its send failed", () =>
    withSdk(true, () =>
      Effect.gen(function* () {
        answer = {
          status: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "internal", message: "Down" }),
        };

        yield* report(new TypeError("boom"));
        yield* report(new TypeError("boom"));

        expect(received).toHaveLength(1);
      }),
    ));

  it("sends nothing for as long as the service asks after refusing a report", () =>
    withSdk(true, () =>
      Effect.gen(function* () {
        answer = {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
          body: JSON.stringify({ code: "rate_limited", message: "Too many error reports" }),
        };

        yield* report(new TypeError("first"));
        answer = ACCEPTED;
        yield* report(new TypeError("second"));
        yield* TestClock.adjust(119_000);
        yield* report(new TypeError("third"));

        expect(received).toHaveLength(1);

        yield* TestClock.adjust(1000);
        yield* report(new TypeError("fourth"));

        expect(received.map((entry) => entry.body)).toMatchObject([
          { message: "first" },
          { message: "fourth" },
        ]);
      }),
    ));
});
