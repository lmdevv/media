import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { BackupId } from "@media/contracts/ids";
import { Effect, Layer, Option, Predicate, Redacted } from "effect";
import type { Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as Movies from "./movies";
import { MoviesClient } from "./movies-client";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";

const mediaRequests: Array<{ readonly url: string; readonly auth: string | undefined }> = [];

const media = createServer((request: IncomingMessage, response: ServerResponse) => {
  request.resume();
  request.on("end", () => {
    mediaRequests.push({ url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
});

let mediaUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => media.listen(0, "127.0.0.1", resolve));
  const address = media.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  mediaUrl = `http://127.0.0.1:${String(address.port)}/`;
});

afterAll(() => {
  media.close();
});

const withSdk = <A, E>(
  options: { readonly mediaUrl: Option.Option<string> },
  body: (fake: FakeConvex.FakeConvex) => Effect.Effect<A, E, Movies.Services | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        const sdk = yield* Layer.build(
          Movies.layer({
            convexUrl: fake.url,
            mediaUrl: options.mediaUrl,
            connection: "http",
          }).pipe(Layer.provide(TokenStorage.layerMemory)),
        );

        return yield* body(fake).pipe(Effect.provideContext(sdk));
      }),
    ),
  );

const pendingLogin = {
  deviceCode: "device-secret",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://movies.example.com/device",
  expiresAt: 1_760_000_000_000,
};

describe("MoviesClient", () => {
  it("encodes a command's arguments and decodes its result", () =>
    withSdk({ mediaUrl: Option.none() }, (fake) =>
      Effect.gen(function* () {
        yield* fake.reply("deviceAuth:request", Reply.Success({ value: pendingLogin }));
        const client = yield* MoviesClient;

        const result = yield* client.run("deviceAuth.request", { clientName: "Living room" });

        expect(result).toStrictEqual(pendingLogin);
        expect(yield* fake.requests).toStrictEqual([
          {
            kind: "action",
            path: "deviceAuth:request",
            args: { clientName: "Living room" },
            authorization: undefined,
          },
        ]);
      }),
    ));

  it("rejects arguments the schema refuses without calling the server", () =>
    withSdk({ mediaUrl: Option.none() }, (fake) =>
      Effect.gen(function* () {
        const client = yield* MoviesClient;

        const failure = yield* client
          .action("deviceAuth.request", { clientName: "" })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ _tag: "InvalidArgs" });
        expect(failure.message).toMatch(/^Invalid arguments for deviceAuth\.request: /u);
        expect(yield* fake.requests).toStrictEqual([]);
      }),
    ));

  it("reports a result outside the contract as a protocol error", () =>
    withSdk({ mediaUrl: Option.none() }, (fake) =>
      Effect.gen(function* () {
        yield* fake.reply("deviceAuth:status", Reply.Success({ value: { state: "lost" } }));
        const client = yield* MoviesClient;

        const failure = yield* client
          .query("deviceAuth.status", { deviceCode: "device-secret" })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "ProtocolError",
          operation: "deviceAuth.status",
          message: "Protocol error in deviceAuth.status: the result does not match the contract",
        });
      }),
    ));

  it("turns a command failure from the server into its tagged error", () =>
    withSdk({ mediaUrl: Option.none() }, (fake) =>
      Effect.gen(function* () {
        yield* fake.reply(
          "deviceAuth:status",
          Reply.Failure({ code: "not_found", message: "No such sign-in" }),
        );
        const client = yield* MoviesClient;

        const failure = yield* client
          .query("deviceAuth.status", { deviceCode: "device-secret" })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ _tag: "NotFound", message: "No such sign-in" });
      }),
    ));

  it("fails a media command when no media service URL is configured", () =>
    withSdk({ mediaUrl: Option.none() }, () =>
      Effect.gen(function* () {
        const client = yield* MoviesClient;

        const failure = yield* client
          .media("backups.restore", { backupId: BackupId.make("backup-1") })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "TransportError",
          operation: "backups.restore",
          message: "Transport failed during backups.restore: no media service URL is configured",
        });
      }),
    ));

  it("sends a media command with the session's token as the bearer", () =>
    withSdk({ mediaUrl: Option.some(mediaUrl) }, (fake) =>
      Effect.gen(function* () {
        const token = jwtExpiringAt(Date.now() + 3_600_000);

        yield* fake.reply(
          "auth:signIn",
          Reply.Success({ value: { tokens: { token, refreshToken: "refresh-1" } } }),
        );
        const auth = yield* Auth.Auth;
        const client = yield* MoviesClient;

        yield* auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make("movies_key") }));

        const result = yield* client.run("backups.restore", {
          backupId: BackupId.make("backup-1"),
        });

        expect(result).toStrictEqual({ ok: true });
        expect(mediaRequests.at(-1)).toStrictEqual({
          url: "/api/backups/restore",
          auth: `Bearer ${token}`,
        });
      }),
    ));
});
