import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http";

import { testConfigLayer } from "../testing/test-config.ts";
import * as WebApp from "./web-app.ts";

class Site extends Context.Service<Site, { readonly baseUrl: string }>()("test/WebAppSite") {}

const siteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-web-" });
    const dist = path.join(root, "dist");

    yield* fs.makeDirectory(path.join(dist, "assets"), { recursive: true });
    yield* fs.writeFileString(
      path.join(dist, "index.html"),
      "<!doctype html><title>[movies]</title>",
    );
    yield* fs.writeFileString(path.join(dist, "assets", "app-3f9a.js"), "console.log(1)");
    yield* fs.writeFileString(path.join(dist, "favicon.svg"), "<svg/>");
    yield* fs.writeFileString(path.join(dist, "favicon.ico"), "ico");
    yield* fs.writeFileString(path.join(dist, "icon-192.png"), "png");
    yield* fs.writeFileString(path.join(dist, "manifest.webmanifest"), "{}");
    yield* fs.writeFileString(path.join(root, "secret.txt"), "secret");
    yield* fs.symlink(path.join(root, "secret.txt"), path.join(dist, "leak.txt"));

    const server = HttpRouter.serve(WebApp.layer, {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(testConfigLayer({ WEB_DIST_DIR: dist })),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    );

    const site = Layer.effect(
      Site,
      HttpServer.addressFormattedWith((baseUrl) => Effect.succeed(Site.of({ baseUrl }))),
    );

    return site.pipe(Layer.provideMerge(server));
  }).pipe(Effect.orDie),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));

const fetchPage = Effect.fn(function* (pathname: string, accept: string = "text/html") {
  const { baseUrl } = yield* Site;

  const response = yield* HttpClient.get(`${baseUrl}${pathname}`, { headers: { accept } }).pipe(
    Effect.orDie,
  );

  const body = yield* response.text.pipe(Effect.orDie);

  return {
    status: response.status,
    body,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
  };
});

describe("web app", () => {
  layer(siteLayer, { excludeTestServices: true })((it) => {
    it.effect("serves files with cache headers and falls back to index.html for app routes", () =>
      Effect.gen(function* () {
        const index = yield* fetchPage("/");

        assert.deepStrictEqual([index.status, index.cacheControl], [200, "no-cache"]);
        assert.include(index.body, "[movies]");

        const route = yield* fetchPage("/titles/abc/play");

        assert.deepStrictEqual([route.status, route.body], [200, index.body]);
        const asset = yield* fetchPage("/assets/app-3f9a.js", "*/*");

        assert.deepStrictEqual(
          [asset.status, asset.cacheControl],
          [200, "public, max-age=31536000, immutable"],
        );
        assert.strictEqual(
          (yield* fetchPage("/favicon.svg", "*/*")).cacheControl,
          "public, max-age=3600",
        );
      }),
    );

    it.effect("serves the icons and the manifest with their content types", () =>
      Effect.gen(function* () {
        const served = [];

        for (const pathname of [
          "/favicon.ico",
          "/favicon.svg",
          "/icon-192.png",
          "/manifest.webmanifest",
        ]) {
          const page = yield* fetchPage(pathname, "*/*");

          served.push([pathname, page.status, page.contentType, page.cacheControl]);
        }

        assert.deepStrictEqual(served, [
          ["/favicon.ico", 200, "image/x-icon", "public, max-age=3600"],
          ["/favicon.svg", 200, "image/svg+xml", "public, max-age=3600"],
          ["/icon-192.png", 200, "image/png", "public, max-age=3600"],
          ["/manifest.webmanifest", 200, "application/manifest+json", "public, max-age=3600"],
        ]);
      }),
    );

    it.effect("never serves outside the folder or answers API paths with the app", () =>
      Effect.gen(function* () {
        for (const pathname of [
          "/leak.txt",
          "/../secret.txt",
          "/%2e%2e/secret.txt",
          "/missing.js",
          "/api/nothing",
          "/media/x",
        ]) {
          const page = yield* fetchPage(pathname);

          assert.strictEqual(page.status, 404, pathname);
          assert.notInclude(page.body, "secret");
          assert.notInclude(page.body, "[movies]");
        }
      }),
    );
  });
});
