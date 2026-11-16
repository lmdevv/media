import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { serve, tracesRequest } from "./http-server.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("server spans", () => {
  it("traces paths on this server outside /media/ and /music/", () => {
    for (const url of ["/api/health", "/invite/code", "/%5Cinvite/code", "/sign-in?redirect=x"]) {
      expect(tracesRequest(url), url).toBe(true);
    }
  });

  it("traces no playback URL and no URL a span would read with another host", () => {
    for (const url of [
      "/media/hls/abc/1/index.m3u8?token=x",
      "/./media/hls/abc/1/index.m3u8?token=x",
      "/media/music/stream/abc?ticket=x&p=fmp4-aac",
      "/music/art/0123?ticket=x",
      "//invite/code",
      "/\\invite/code",
      "\\\\invite/code",
      "\\/invite/code",
      "http://elsewhere/invite/code",
    ]) {
      expect(tracesRequest(url), url).toBe(false);
    }
  });
});

describe("a HEAD whose client leaves", () => {
  it("never holds up the server's shutdown", async () => {
    const started = await run(Deferred.make<void>());
    const left = await run(Deferred.make<void>());

    // A HEAD the router answers from this GET route, which never answers.
    const route = HttpRouter.add(
      "GET",
      "/never",
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(left, undefined)),
      ),
    );

    const scope = await run(Scope.make());

    const built = await run(
      Layer.buildWithScope(
        serve(route).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, {
              port: 0,
              host: "127.0.0.1",
              gracefulShutdownTimeout: Duration.millis(100),
            }),
          ),
        ),
        scope,
      ),
    );

    const baseUrl = await run(
      HttpServer.addressFormattedWith((url) => Effect.succeed(url)).pipe(
        Effect.provideContext(built),
      ),
    );

    const client = new AbortController();

    const asked = fetch(`${baseUrl}/never`, { method: "HEAD", signal: client.signal }).catch(
      () => null,
    );

    await run(Deferred.await(started));
    client.abort();
    await asked;
    await run(Deferred.await(left));

    const closed = await run(
      Scope.close(scope, Exit.void).pipe(
        Effect.forkDetach,
        Effect.flatMap((closing) =>
          Fiber.await(closing).pipe(Effect.timeoutOption(Duration.seconds(5))),
        ),
      ),
    );

    expect(Option.isSome(closed)).toBe(true);
  }, 30_000);
});
