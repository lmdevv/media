import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { createPlatform } from "@media/sdk/promise";
import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { jwtExpiringAt, Reply } from "@media/sdk/testing/fake-convex";
import { Effect, Predicate } from "effect";
import { describe, expect, it } from "vitest";

import { mediaServerOf } from "./media-server";

const REPORT = {
  platform: "ios",
  appVersion: "test",
  kind: "render",
  route: "/",
  name: "Error",
  message: "boom",
} as const;

/** A media server that refuses every call as an ended session, recording the bearers it saw. */
const refusingMediaServer = () => {
  const bearers: Array<string | undefined> = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    bearers.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ code: "unauthenticated", message: "This session has ended" }));
    });
  });

  const url = Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            resolve(
              address === null || Predicate.isString(address)
                ? ""
                : `http://127.0.0.1:${address.port}`,
            );
          });
        }),
    ),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

  return { url, bearers };
};

describe("the app's media server", () => {
  it("refreshes the session once after the media server refuses it, and signs out when that is refused", async () => {
    const token = jwtExpiringAt(Date.now() + 3_600_000, "user-1|session-1");
    const media = refusingMediaServer();

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          // A sign-in gets the session; its refresh token is no longer known.
          yield* fake.handle("auth:signIn", (request) =>
            Effect.succeed(
              Predicate.hasProperty(request.args, "refreshToken")
                ? Reply.Success({ value: { tokens: null } })
                : Reply.Success({ value: { tokens: { token, refreshToken: "refresh-1" } } }),
            ),
          );

          const url = yield* media.url;

          const platform = createPlatform({
            url: fake.url,
            signInUrl: fake.signInUrl,
            connection: "http",
          });

          const outcome = yield* Effect.promise(async () => {
            await platform.session.signInWithPassword({ username: "ada", password: "secret" });
            const server = mediaServerOf(platform, url);

            const rejected = await server.reportError(REPORT).then(
              () => null,
              (error: Error) => error,
            );

            const status = await platform.session.status();
            const shared = mediaServerOf(platform, url) === server;

            await platform.dispose();

            return { rejected, status, shared };
          });

          const refreshes = (yield* fake.requestsTo("auth:signIn")).filter((request) =>
            Predicate.hasProperty(request.args, "refreshToken"),
          ).length;

          return { ...outcome, refreshes };
        }),
      ),
    );

    expect(answer).toMatchObject({
      rejected: { _tag: "Unauthenticated" },
      status: "signedOut",
      shared: true,
      refreshes: 1,
    });
    expect(media.bearers).toStrictEqual([`Bearer ${token}`]);
  });
});
