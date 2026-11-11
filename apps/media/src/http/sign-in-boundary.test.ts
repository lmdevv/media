import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { addressBudgets } from "@media/contracts/rate-limit";
import { loadPassKeys, PASS_PARAM, SIGN_IN_PATH } from "@media/contracts/sign-in";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as SignInBoundary from "./sign-in-boundary.ts";
import * as SignInPasses from "./sign-in-passes.ts";

const RING = `k1:${Buffer.alloc(32, 7).toString("base64url")}`;

const Received = Schema.Struct({
  path: Schema.String,
  args: Schema.Struct({
    provider: Schema.String,
    params: Schema.Record(Schema.String, Schema.Json),
  }),
});

type Received = typeof Received.Type;

interface CoreReply {
  readonly status: number;
  readonly body: unknown;
}

/** A stand-in for the core's Convex HTTP API, answering `auth:signIn` as told. */
class FakeCore extends Context.Service<
  FakeCore,
  {
    readonly url: string;
    readonly received: Array<Received>;
    readonly answer: { current: () => CoreReply };
  }
>()("test/FakeCore") {}

const signedIn: CoreReply = {
  status: 200,
  body: { status: "success", value: { tokens: { token: "jwt", refreshToken: "refresh" } } },
};

const refusedWith = (code: string, message: string): CoreReply => ({
  status: 560,
  body: { status: "error", errorMessage: message, errorData: { code, message } },
});

const fakeCoreLayer = Layer.effect(
  FakeCore,
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: ReturnType<typeof createServer>;
      readonly core: FakeCore["Service"];
    }>((resume) => {
      const received: Array<Received> = [];
      const answer = { current: (): CoreReply => signedIn };

      const server = createServer((request, response) => {
        let text = "";

        request.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });

        request.on("end", () => {
          const call = Schema.decodeSync(Schema.fromJsonString(Received))(text);

          received.push(call);
          const reply = answer.current();

          response.writeHead(reply.status, { "content-type": "application/json" });
          response.end(JSON.stringify(reply.body));
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
          server.address(),
        );

        resume(
          Effect.succeed({
            server,
            core: FakeCore.of({ url: `http://127.0.0.1:${String(port)}`, received, answer }),
          }),
        );
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ core }) => core)),
);

class Boundary extends Context.Service<Boundary, { readonly url: string }>()("test/Boundary") {}

const boundaryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const core = yield* FakeCore;

    const server = HttpRouter.serve(SignInBoundary.layer({ coreUrl: core.url }), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(SignInPasses.layer(Redacted.make(RING))),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const boundary = Layer.effect(
      Boundary,
      HttpServer.addressFormattedWith((baseUrl) =>
        Effect.succeed(Boundary.of({ url: `${baseUrl}${SIGN_IN_PATH}` })),
      ),
    );

    return boundary.pipe(Layer.provideMerge(server));
  }).pipe(Effect.orDie),
).pipe(
  Layer.provideMerge(fakeCoreLayer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

let clients = 0;

/** A password no one holds, made per test so no fixed one sits in the source. */
const secret = (): string => `secret-${crypto.randomUUID()}`;

const newAddress = (): string => {
  clients += 1;

  return `198.18.0.${String(clients)}`;
};

const post = Effect.fn(function* (body: string, address: string) {
  const { url } = yield* Boundary;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-forwarded-for", address),
      HttpClientRequest.bodyText(body, "application/json"),
    ),
  ).pipe(Effect.orDie);

  return {
    status: response.status,
    retryAfter: response.headers["retry-after"],
    body: yield* response.json.pipe(Effect.orDie),
  };
});

const signIn = (params: Record<string, Schema.Json>, address: string, provider = "password") =>
  post(JSON.stringify({ provider, params }), address);

const keys = Effect.promise(async () => {
  const loaded = await loadPassKeys(RING);

  if (!loaded.ok) throw new Error("the test ring is unusable");

  return loaded.value;
});

describe("the sign-in boundary", () => {
  layer(boundaryLayer, { excludeTestServices: true })((it) => {
    it.effect("relays a sign-in to auth:signIn with a pass for exactly it, from its address", () =>
      Effect.gen(function* () {
        const core = yield* FakeCore;
        const address = newAddress();
        const params = { username: "ana", password: secret() };

        core.answer.current = () => signedIn;
        const answered = yield* signIn({ ...params, [PASS_PARAM]: "forged" }, address);

        assert.deepStrictEqual(answered, {
          status: 200,
          retryAfter: undefined,
          body: { tokens: { token: "jwt", refreshToken: "refresh" } },
        });

        const call = core.received.at(-1);

        assert.strictEqual(call?.path, "auth:signIn");
        const { [PASS_PARAM]: pass, ...own } = call?.args.params ?? {};

        assert.deepStrictEqual(own, params);
        assert.isString(pass);
        assert.notStrictEqual(pass, "forged");

        const passKeys = yield* keys;

        const checked = yield* Effect.promise(() =>
          passKeys.verify(pass ?? null, "password", params, Date.now()),
        );

        assert.deepInclude(checked, { ok: true });
      }),
    );

    it.effect("answers the core's refusals with their code, and waiting codes too", () =>
      Effect.gen(function* () {
        const core = yield* FakeCore;

        core.answer.current = () => refusedWith("unauthenticated", "Wrong username or password");

        assert.deepStrictEqual(
          yield* signIn({ username: "ana", password: secret() }, newAddress()),
          {
            status: 401,
            retryAfter: undefined,
            body: { code: "unauthenticated", message: "Wrong username or password" },
          },
        );

        core.answer.current = () => refusedWith("pending", "Waiting for approval");

        const pending = yield* signIn({ deviceCode: "dc_x.y" }, newAddress(), "deviceCode");

        assert.deepStrictEqual(pending.body, { code: "pending", message: "Waiting for approval" });

        core.answer.current = () => ({
          status: 560,
          body: { status: "error", errorMessage: "Server Error" },
        });

        assert.deepStrictEqual(
          (yield* signIn({ username: "ana", password: secret() }, newAddress())).body,
          { code: "internal", message: "The core failed while signing in" },
        );
      }),
    );

    it.effect(
      "answers the eleventh fast sign-in from one address with a rate limit the core never sees",
      () =>
        Effect.gen(function* () {
          const core = yield* FakeCore;
          const address = newAddress();
          const before = core.received.length;
          const statuses: Array<number> = [];

          let limited:
            | { readonly retryAfter: string | undefined; readonly body: unknown }
            | undefined;

          core.answer.current = () => refusedWith("unauthenticated", "Wrong username or password");

          for (let attempt = 0; attempt < 20; attempt += 1) {
            const answered = yield* signIn({ username: "aiko", password: secret() }, address);

            statuses.push(answered.status);

            if (answered.status === 429) limited = answered;
          }

          const burst = addressBudgets.signIn.burst;

          assert.deepStrictEqual(statuses, [
            ...Array.from({ length: burst }, () => 401),
            ...Array.from({ length: 20 - burst }, () => 429),
          ]);
          assert.strictEqual(core.received.length - before, burst);
          assert.strictEqual(limited?.retryAfter, "5");
          assert.deepInclude(limited?.body, { code: "rate_limited" });

          core.answer.current = () => signedIn;

          assert.strictEqual(
            (yield* signIn({ username: "mateo", password: secret() }, newAddress())).status,
            200,
          );
        }),
    );

    it.effect("counts an IPv4 client and its IPv4-mapped IPv6 form as one address", () =>
      Effect.gen(function* () {
        const core = yield* FakeCore;
        const statuses: Array<number> = [];

        core.answer.current = () => refusedWith("unauthenticated", "Wrong username or password");

        for (const address of ["198.51.100.77", "::ffff:198.51.100.77", "::FFFF:C633:644D"]) {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            statuses.push(
              (yield* signIn({ username: "aiko", password: secret() }, address)).status,
            );
          }
        }

        assert.deepStrictEqual(statuses, [
          ...Array.from({ length: addressBudgets.signIn.burst }, () => 401),
          ...Array.from({ length: 15 - addressBudgets.signIn.burst }, () => 429),
        ]);
      }),
    );

    it.effect("refuses a body that is not a sign-in, without asking the core", () =>
      Effect.gen(function* () {
        const core = yield* FakeCore;
        const before = core.received.length;

        for (const body of [
          "not json",
          JSON.stringify({ provider: "email", params: {} }),
          JSON.stringify({ provider: "password" }),
          JSON.stringify({ provider: "password", params: { padding: "x".repeat(20_000) } }),
        ]) {
          const answered = yield* post(body, newAddress());

          assert.strictEqual(answered.status, 400);
          assert.deepInclude(answered.body, { code: "invalid_args" });
        }

        assert.strictEqual(core.received.length, before);
      }),
    );
  });

  layer(
    Layer.effect(
      Boundary,
      HttpServer.addressFormattedWith((baseUrl) =>
        Effect.succeed(Boundary.of({ url: `${baseUrl}${SIGN_IN_PATH}` })),
      ),
    ).pipe(
      Layer.provideMerge(
        HttpRouter.serve(SignInBoundary.layer({ coreUrl: "http://127.0.0.1:9" }), {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(
          Layer.provide(SignInPasses.layer(Redacted.make(RING))),
          Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      Layer.orDie,
    ),
    { excludeTestServices: true },
  )((it) => {
    it.effect("answers 502 while the core is unreachable", () =>
      Effect.gen(function* () {
        const answered = yield* signIn({ username: "ana", password: secret() }, newAddress());

        assert.strictEqual(answered.status, 502);
        assert.deepInclude(answered.body, { code: "internal" });
      }),
    );
  });
});
