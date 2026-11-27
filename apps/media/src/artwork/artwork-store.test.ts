import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { testArtworkKeysLayer } from "../testing/test-tokens.ts";
import * as ArtworkKeys from "./artwork-keys.ts";
import * as ArtworkStore from "./artwork-store.ts";

const SMALL = new Uint8Array(1024).fill(7);

const MEGABYTE = new Uint8Array(1024 * 1024).fill(1);

class ImageHost extends Context.Service<ImageHost, { readonly baseUrl: string }>()(
  "test/ImageHost",
) {}

/** Answers a provider image request: `landscape` for one whose URL says so. */
const respond = (landscape: Uint8Array) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.url.includes("oversized")) {
      return HttpServerResponse.stream(
        Stream.fromIterable(Array.from({ length: 21 }, () => MEGABYTE)),
        { contentType: "image/jpeg" },
      );
    }

    return HttpServerResponse.uint8Array(request.url.includes("landscape") ? landscape : SMALL, {
      contentType: "image/jpeg",
    });
  });

/** A 1,200 by 600 JPEG. */
const makeLandscape = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-artwork-landscape-" });
  const file = path.join(directory, "landscape.jpg");

  yield* tools.ffmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1200x600",
    "-frames:v",
    "1",
    "-q:v",
    "1",
    file,
  ]);

  return yield* fs.readFile(file);
});

const imageHost = Layer.unwrap(
  makeLandscape.pipe(
    Effect.orDie,
    Effect.map((landscape) =>
      Layer.effect(
        ImageHost,
        HttpServer.addressFormattedWith((baseUrl) => Effect.succeed(ImageHost.of({ baseUrl }))),
      ).pipe(
        Layer.provideMerge(
          HttpRouter.serve(HttpRouter.add("GET", "/*", respond(landscape)), {
            disableLogger: true,
            disableListenLog: true,
          }),
        ),
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      ),
    ),
  ),
).pipe(
  // Its own tools and configuration, apart from the store's under test.
  Layer.provide(
    MediaTools.layer.pipe(Layer.provide(Layer.fresh(testConfigLayer({}))), Layer.fresh),
  ),
);

const redirectedClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const host = yield* ImageHost;
    const client = yield* HttpClient.HttpClient;

    return client.pipe(
      HttpClient.mapRequest((request) =>
        HttpClientRequest.setUrl(
          request,
          request.url.replace("https://image.tmdb.org", host.baseUrl),
        ),
      ),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const storeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-artwork-" });
    const library = yield* fs.makeTempDirectoryScoped({ prefix: "media-artwork-library-" });

    return ArtworkStore.layer.pipe(
      Layer.provideMerge(testArtworkKeysLayer),
      Layer.provideMerge(MediaTools.layer),
      Layer.provide(redirectedClient),
      Layer.provideMerge(testConfigLayer({ DATA_DIR: dataDir, LIBRARY_ROOTS: library })),
    );
  }).pipe(Effect.orDie),
).pipe(Layer.provideMerge(imageHost), Layer.provideMerge(NodeServices.layer));

describe("artwork store", () => {
  layer(storeLayer, { excludeTestServices: true })((it) => {
    it.effect("downloads provider images and refuses ones over the size cap", () =>
      Effect.gen(function* () {
        const store = yield* ArtworkStore.Service;
        const keys = yield* ArtworkKeys.Service;
        const fs = yield* FileSystem.FileSystem;

        const small = yield* keys.seal(
          ArtworkKeys.ArtworkSource.Remote({ url: "https://image.tmdb.org/t/p/w500/small.jpg" }),
        );

        const image = yield* store.image(small, Option.none());

        assert.deepStrictEqual(yield* fs.readFile(image.path), SMALL);

        const oversized = yield* keys.seal(
          ArtworkKeys.ArtworkSource.Remote({
            url: "https://image.tmdb.org/t/p/original/oversized.jpg",
          }),
        );

        const error = yield* store.image(oversized, Option.none()).pipe(Effect.flip);

        assert.isTrue(Predicate.isTagged(error, "ArtworkUnavailable"));
        assert.include(String(error.cause), "ArtworkTooLarge");
      }),
    );

    it.effect(
      "resizes movie artwork by its width and a music cover by its shorter side, never confusing the two",
      () =>
        Effect.gen(function* () {
          const store = yield* ArtworkStore.Service;
          const keys = yield* ArtworkKeys.Service;
          const tools = yield* MediaTools.Service;
          const url = "https://image.tmdb.org/t/p/original/landscape.jpg";

          const sizeOf = (file: string) =>
            tools
              .ffprobe([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                file,
              ])
              .pipe(Effect.map((out) => out.trim()));

          const key = yield* keys.seal(ArtworkKeys.ArtworkSource.Remote({ url }));
          const original = yield* store.image(key, Option.none());

          // A remote image's fingerprint is its URL, so both copies below share file and fingerprint.
          const poster = yield* store.image(key, Option.some(342));
          const cover = yield* store.coverCopy(original.path, url, 336, "jpeg");
          const posterAgain = yield* store.image(key, Option.some(342));

          assert.strictEqual(yield* sizeOf(poster.path), "342,172");
          assert.isTrue(ArtworkStore.CoverCopy.$is("Copy")(cover));

          if (!ArtworkStore.CoverCopy.$is("Copy")(cover)) return;
          assert.strictEqual(yield* sizeOf(cover.image.path), "672,336");
          assert.notStrictEqual(cover.image.path, poster.path);
          assert.strictEqual(posterAgain.path, poster.path);
          assert.strictEqual(yield* sizeOf(posterAgain.path), "342,172");
        }),
    );

    it.effect("reports a resize it cannot store as unavailable", () =>
      Effect.gen(function* () {
        const store = yield* ArtworkStore.Service;
        const keys = yield* ArtworkKeys.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* MediaConfig.Service;

        yield* fs.makeDirectory(path.join(config.dataDir, "artwork"), { recursive: true });
        yield* fs.writeFileString(path.join(config.dataDir, "artwork", "w185"), "");

        const key = yield* keys.seal(
          ArtworkKeys.ArtworkSource.Remote({ url: "https://image.tmdb.org/t/p/w500/blocked.jpg" }),
        );

        const error = yield* store.image(key, Option.some(185)).pipe(Effect.flip);

        assert.isTrue(Predicate.isTagged(error, "ArtworkUnavailable"));
        assert.include(String(error.cause), "AlreadyExists");
        assert.include(String(error.cause), "makeDirectory");
      }),
    );

    it.effect(
      "serves library artwork from its real path, so a link swapped later cannot redirect",
      () =>
        Effect.gen(function* () {
          const store = yield* ArtworkStore.Service;
          const keys = yield* ArtworkKeys.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* MediaConfig.Service;
          const library = config.libraryRoots[0] ?? "";

          yield* fs.writeFile(path.join(library, "poster-original.jpg"), SMALL);
          yield* fs.symlink(
            path.join(library, "poster-original.jpg"),
            path.join(library, "poster.jpg"),
          );

          const key = yield* keys.seal(
            ArtworkKeys.ArtworkSource.Local({ path: path.join(library, "poster.jpg") }),
          );

          const image = yield* store.image(key, Option.none());

          assert.strictEqual(
            image.path,
            yield* fs.realPath(path.join(library, "poster-original.jpg")),
          );
        }),
    );
  });
});
