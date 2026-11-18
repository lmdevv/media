import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Redacted, Ref } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import type { LocalMetadata } from "../library/nfo.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as DiskCache from "../disk-cache.ts";
import { guardHosts } from "./metadata-plugin.ts";
import * as MetadataPlugin from "./metadata-plugin.ts";
import * as Omdb from "./omdb.ts";
import * as MetadataResolver from "./title-metadata.ts";
import * as Tmdb from "./tmdb.ts";
import collection from "./tmdb-fixtures/collection-700001.json" with { type: "json" };
import findImdb from "./tmdb-fixtures/find-tt1254207.json" with { type: "json" };
import bigBuckBunny from "./tmdb-fixtures/movie-10378.json" with { type: "json" };
import remuxFixture from "./tmdb-fixtures/movie-500001.json" with { type: "json" };
import omdbRemux from "./tmdb-fixtures/omdb-tt5000001.json" with { type: "json" };
import person from "./tmdb-fixtures/person-9001.json" with { type: "json" };
import searchMovie from "./tmdb-fixtures/search-movie.json" with { type: "json" };
import searchTv from "./tmdb-fixtures/search-tv.json" with { type: "json" };
import seasonOne from "./tmdb-fixtures/tv-99999-season-1.json" with { type: "json" };
import show from "./tmdb-fixtures/tv-99999.json" with { type: "json" };

const API_KEY = "0123456789abcdef0123456789abcdef";

const READ_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-read-token";

const OMDB_KEY = "omdb-test-key";

const OMDB: ReadonlyMap<string, string> = new Map([["tt5000001", JSON.stringify(omdbRemux)]]);

const FIXTURES: ReadonlyMap<string, string> = new Map([
  ["/3/search/movie", JSON.stringify(searchMovie)],
  ["/3/movie/500001", JSON.stringify(remuxFixture)],
  ["/3/movie/10378", JSON.stringify(bigBuckBunny)],
  ["/3/find/tt1254207", JSON.stringify(findImdb)],
  ["/3/search/tv", JSON.stringify(searchTv)],
  ["/3/tv/99999", JSON.stringify(show)],
  ["/3/tv/99999/season/1", JSON.stringify(seasonOne)],
  ["/3/collection/700001", JSON.stringify(collection)],
  ["/3/person/9001", JSON.stringify(person)],
]);

class FixtureServer extends Context.Service<
  FixtureServer,
  {
    readonly baseUrl: string;
    readonly requests: Ref.Ref<ReadonlyArray<string>>;
    readonly throttleNext: Ref.Ref<boolean>;
  }
>()("test/TmdbFixtureServer") {}

const fixtureServer = Layer.unwrap(
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);
    const throttleNext = yield* Ref.make(false);

    const respond = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://fixture");
      yield* Ref.update(requests, (seen) => [...seen, url.pathname]);

      if (url.pathname === "/") {
        if (url.searchParams.get("apikey") !== OMDB_KEY) {
          return HttpServerResponse.text('{"Response":"False","Error":"Invalid API key!"}', {
            status: 401,
          });
        }

        return HttpServerResponse.text(
          OMDB.get(url.searchParams.get("i") ?? "") ??
            '{"Response":"False","Error":"Incorrect IMDb ID."}',
          { contentType: "application/json" },
        );
      }

      const authorised =
        url.searchParams.get("api_key") === API_KEY ||
        request.headers["authorization"] === `Bearer ${READ_TOKEN}`;

      if (!authorised) return HttpServerResponse.text('{"status_code":7}', { status: 401 });

      if (yield* Ref.getAndSet(throttleNext, false)) {
        return HttpServerResponse.text('{"status_code":25}', {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }

      if (url.pathname.endsWith("/stalled")) yield* Effect.sleep(Duration.seconds(30));
      const body = FIXTURES.get(url.pathname);

      return body === undefined
        ? HttpServerResponse.text('{"status_code":34}', { status: 404 })
        : HttpServerResponse.text(body, { contentType: "application/json" });
    });

    const server = HttpRouter.serve(HttpRouter.add("GET", "/*", respond), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })));

    const service = Layer.effect(
      FixtureServer,
      HttpServer.addressFormattedWith((address) =>
        Effect.succeed(FixtureServer.of({ baseUrl: `${address}/3`, requests, throttleNext })),
      ),
    );

    return service.pipe(Layer.provideMerge(server));
  }),
);

const tmdbOptions = (baseUrl: string, apiKey: string): Tmdb.TmdbOptions => ({
  ...Tmdb.defaultOptions(Option.some(Redacted.make(apiKey))),
  apiBaseUrl: baseUrl,
  imageBaseUrl: "https://images.example/t/p",
  cacheMaxAge: Duration.days(1),
  requestTimeout: Duration.millis(500),
});

const pluginLayer = (apiKey: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* FixtureServer;
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-tmdb-" });

      return Tmdb.layerWithOptions(tmdbOptions(server.baseUrl, apiKey)).pipe(
        Layer.provide(DiskCache.layer),
        Layer.provide(testConfigLayer({ DATA_DIR: dataDir })),
      );
    }).pipe(Effect.orDie),
  );

const omdbLayer = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* FixtureServer;
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-omdb-" });

    return Omdb.layerWithOptions({
      ...Omdb.defaultOptions(Option.some(Redacted.make(OMDB_KEY))),
      apiBaseUrl: server.baseUrl.replace(/\/3$/u, ""),
    }).pipe(Layer.provide(DiskCache.layer), Layer.provide(testConfigLayer({ DATA_DIR: dataDir })));
  }).pipe(Effect.orDie),
);

const refusedOmdbLayer = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* FixtureServer;
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-omdb-refused-" });

    return Omdb.layerWithOptions({
      ...Omdb.defaultOptions(Option.some(Redacted.make("wrong-key"))),
      apiBaseUrl: server.baseUrl.replace(/\/3$/u, ""),
    }).pipe(Layer.provide(DiskCache.layer), Layer.provide(testConfigLayer({ DATA_DIR: dataDir })));
  }).pipe(Effect.orDie),
);

const nfo = (kind: LocalMetadata["kind"], fields: Partial<LocalMetadata> = {}): LocalMetadata => ({
  kind,
  ratings: {},
  genres: [],
  studios: [],
  countries: [],
  tags: [],
  ids: {},
  actors: [],
  directors: [],
  writers: [],
  ...fields,
});

const noActorImages = (): undefined => undefined;

const baseLayer = fixtureServer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

describe("TMDB plugin", () => {
  layer(Layer.provideMerge(pluginLayer(API_KEY), baseLayer), { excludeTestServices: true })(
    "with an API key",
    (it) => {
      it.effect("searches, picks the confident match, and maps details", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const query = { kind: "movie", title: "Remux Fixture", year: 2015, ids: {} } as const;
          const matches = yield* plugin.search(query);

          assert.deepStrictEqual(
            matches.map((match) => [match.providerId, match.year]),
            [
              ["500002", 2017],
              ["500001", 2015],
            ],
          );

          const best = MetadataResolver.bestMatch(query, matches);

          assert.strictEqual(best?.providerId, "500001");
          const details = yield* plugin.titleDetails("movie", "500001");

          assert.deepStrictEqual(details, {
            provider: "tmdb",
            kind: "movie",
            providerId: "500001",
            ids: { tmdb: "500001", imdb: "tt5000001", tvdb: undefined },
            title: "Remux Fixture",
            originalTitle: "Remux Fixture",
            year: 2015,
            releaseDate: "2015-06-12",
            plot: "Codecs collide.",
            tagline: "Every stream has a ladder.",
            runtimeMinutes: 98,
            contentRating: "PG-13",
            rating: { value: 6.8, votes: 340 },
            genres: ["Action", "Science Fiction"],
            studios: ["Fixture Pictures"],
            countries: ["United States of America"],
            tags: ["video codec", "heist"],
            originalLanguage: "en",
            status: undefined,
            trailer: { key: "dQw4w9WgXcQ", name: "Official Trailer" },
            collection: {
              providerId: "700001",
              name: "Remux Fixture Collection",
              overview: undefined,
              images: {
                poster: "https://images.example/t/p/w500/remux-collection-poster.jpg",
                backdrop: "https://images.example/t/p/w1280/remux-collection-backdrop.jpg",
                still: undefined,
              },
            },
            recommendations: ["10378", "500002", "500003"],
            credits: [
              {
                personId: "9001",
                name: "Ada Stream",
                kind: "actor",
                role: "Captain Codec",
                profile: "https://images.example/t/p/w185/ada.jpg",
                order: 0,
              },
              {
                personId: "9002",
                name: "Bruno Bitrate",
                kind: "actor",
                role: "Muxer",
                profile: undefined,
                order: 1,
              },
              {
                personId: "9101",
                name: "Dana Keyframe",
                kind: "director",
                role: undefined,
                profile: "https://images.example/t/p/w185/dana.jpg",
                order: 2,
              },
              {
                personId: "9101",
                name: "Dana Keyframe",
                kind: "writer",
                role: "Screenplay",
                profile: "https://images.example/t/p/w185/dana.jpg",
                order: 3,
              },
              {
                personId: "9102",
                name: "Ezra Opus",
                kind: "composer",
                role: undefined,
                profile: undefined,
                order: 4,
              },
            ],
            images: {
              poster: "https://images.example/t/p/w500/remux-poster.jpg",
              backdrop: "https://images.example/t/p/w1280/remux-backdrop.jpg",
              still: undefined,
            },
          });
        }),
      );

      it.effect("maps a show's regulars, creators, producers, status, and similar shows", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const details = yield* plugin.titleDetails("show", "99999");

          assert.strictEqual(details.status, "returning");
          assert.deepStrictEqual(details.rating, { value: 7.9, votes: 88 });
          assert.deepStrictEqual(details.tags, ["test pattern"]);
          assert.deepStrictEqual(details.recommendations, ["88888"]);
          assert.isUndefined(details.trailer);

          assert.deepStrictEqual(
            details.credits.map((credit) => [credit.name, credit.kind, credit.role ?? null]),
            [
              ["Ada Stream", "actor", "Host"],
              ["Cora Creator", "creator", null],
              ["Pat Producer", "producer", null],
            ],
          );
        }),
      );

      it.effect("maps episode guest stars, directors, writers, and IDs", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const season = yield* plugin.seasonDetails("99999", 1);
          const [pilot, second] = season.episodes;

          assert.strictEqual(season.ids.tmdb, "2001");
          assert.strictEqual(pilot?.ids.tmdb, "1001");
          assert.deepStrictEqual(pilot?.rating, { value: 8.1, votes: 14 });
          assert.isUndefined(second?.rating);

          assert.deepStrictEqual(
            pilot?.credits.map((credit) => [credit.name, credit.kind, credit.role ?? null]),
            [
              ["Gus Guest", "guest-star", "Visiting Engineer"],
              ["Dana Keyframe", "director", null],
              ["Wren Writer", "writer", "Writer"],
            ],
          );
        }),
      );

      it.effect("fetches a collection's overview and a person's details", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const found = yield* plugin.collectionDetails("700001");
          const ada = yield* plugin.personDetails("9001");

          assert.strictEqual(found.overview, "Every Remux Fixture film.");

          assert.deepStrictEqual(ada, {
            providerId: "9001",
            ids: { tmdb: "9001", imdb: "nm0009001", tvdb: "77" },
            name: "Ada Stream",
            biography: "Ada Stream plays captains of every codec.",
            birthDate: "1980-02-29",
            deathDate: undefined,
            birthPlace: "Lisbon, Portugal",
            knownFor: "Acting",
            profile: "https://images.example/t/p/h632/ada.jpg",
          });
        }),
      );

      it.effect("serves repeated requests from the disk cache", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const server = yield* FixtureServer;

          yield* plugin.titleDetails("movie", "10378");
          const before = (yield* Ref.get(server.requests)).length;
          const again = yield* plugin.titleDetails("movie", "10378");

          assert.strictEqual(again.title, "Big Buck Bunny");
          assert.strictEqual((yield* Ref.get(server.requests)).length, before);
        }),
      );

      it.effect("retries after a 429 and resolves external IDs", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const server = yield* FixtureServer;

          yield* Ref.set(server.throttleNext, true);
          const providerId = yield* plugin.findByExternalId("movie", { imdb: "tt1254207" });

          assert.strictEqual(providerId, "10378");
          assert.isFalse(yield* Ref.get(server.throttleNext));
        }),
      );

      it.effect("gives up on a request that never answers", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const error = yield* plugin.titleDetails("movie", "stalled").pipe(Effect.flip);

          assert.instanceOf(error, MetadataPlugin.MetadataRequestFailed);
          assert.include(error.message, "timed out");
        }),
      );

      it.effect("reports a missing title as a typed failure", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const error = yield* plugin.titleDetails("movie", "404404").pipe(Effect.flip);

          assert.instanceOf(error, MetadataPlugin.MetadataRequestFailed);
          assert.strictEqual(
            error instanceof MetadataPlugin.MetadataRequestFailed && error.status,
            404,
          );
        }),
      );

      it.layer(refusedOmdbLayer)((withRefused) => {
        withRefused.effect("stops asking OMDb for an hour once it refuses the key", () =>
          Effect.gen(function* () {
            const server = yield* FixtureServer;
            const omdb = yield* Omdb.Service;

            const asked = () =>
              Ref.get(server.requests).pipe(
                Effect.map((paths) => paths.filter((path) => path === "/").length),
              );

            const before = yield* asked();

            assert.deepStrictEqual(yield* omdb.ratings("tt5000001"), {});
            assert.deepStrictEqual(yield* omdb.ratings("tt5000002"), {});
            assert.strictEqual((yield* asked()) - before, 1);
          }),
        );
      });

      it.layer(Layer.provide(MetadataResolver.layer, omdbLayer))((withResolver) => {
        withResolver.effect("merges a movie: NFO first, then OMDb scores, then TMDB", () =>
          Effect.gen(function* () {
            const resolver = yield* MetadataResolver.Service;

            const resolved = yield* resolver.title({
              kind: "movie",
              title: "Remux Fixture",
              year: 2015,
              nameIds: {},
              local: nfo("movie", {
                ids: { tmdb: "500001" },
                ratings: { rottenTomatoes: 90 },
                actors: [{ name: "ada stream", role: "Local Role", ids: {} }],
              }),
              artwork: {},
              actorImages: (name) =>
                name === "ada stream" ? "Remux Fixture (2015)/.actors/ada_stream.jpg" : undefined,
            });

            const { metadata } = resolved;

            assert.deepStrictEqual(metadata.ratings, {
              tmdb: { value: 6.8, votes: 340 },
              imdb: { value: 7.4, votes: 12345 },
              rottenTomatoes: 90,
              metacritic: 61,
            });

            assert.deepStrictEqual(metadata.collection, {
              sourceKey: "tmdb:700001",
              name: "Remux Fixture Collection",
              overview: "Every Remux Fixture film.",
              poster: undefined,
              backdrop: undefined,
            });

            assert.deepStrictEqual(metadata.trailer, {
              key: "dQw4w9WgXcQ",
              name: "Official Trailer",
            });

            assert.deepStrictEqual(
              metadata.credits.map((credit) => [
                credit.name,
                credit.kind,
                credit.role ?? null,
                credit.ids.tmdb ?? null,
              ]),
              [
                ["ada stream", "actor", "Local Role", "9001"],
                ["Dana Keyframe", "director", null, "9101"],
                ["Dana Keyframe", "writer", "Screenplay", "9101"],
                ["Ezra Opus", "composer", null, "9102"],
              ],
            );

            assert.deepStrictEqual(metadata.credits[0]?.profile, {
              _tag: "Local",
              path: "Remux Fixture (2015)/.actors/ada_stream.jpg",
            });
          }),
        );

        withResolver.effect("merges a show and its episodes, local NFO values first", () =>
          Effect.gen(function* () {
            const resolver = yield* MetadataResolver.Service;

            const resolved = yield* resolver.title({
              kind: "show",
              title: "Fixture Show",
              year: 2021,
              nameIds: {},
              local: nfo("show", { plot: "Local plot." }),
              artwork: { poster: "Fixture Show (2021)/poster.png" },
              actorImages: noActorImages,
            });

            assert.strictEqual(resolved.providerId, "99999");
            assert.strictEqual(resolved.metadata.plot, "Local plot.");
            assert.strictEqual(resolved.metadata.contentRating, "TV-14");
            assert.deepStrictEqual(resolved.metadata.genres, ["Drama"]);
            assert.deepStrictEqual(resolved.metadata.ids, {
              tmdb: "99999",
              imdb: "tt9999999",
              tvdb: "123456",
            });
            assert.deepStrictEqual(resolved.metadata.poster, {
              _tag: "Local",
              path: "Fixture Show (2021)/poster.png",
            });
            assert.deepStrictEqual(resolved.metadata.backdrop, {
              _tag: "Remote",
              url: "https://images.example/t/p/w1280/show-backdrop.jpg",
            });
            assert.deepStrictEqual(resolved.metadata.sources, ["name", "nfo", "provider"]);

            const episode = yield* resolver.episode(resolved.providerId, {
              name: {
                _tag: "Episode",
                showTitle: "Fixture Show",
                showYear: 2021,
                season: 1,
                episodes: [1],
                episodeTitle: "Pilot",
                showIds: {},
              },
              local: nfo("episode", { title: "Pilot (Local)" }),
              still: undefined,
              seasonPoster: undefined,
              actorImages: noActorImages,
            });

            assert.strictEqual(episode.title, "Pilot (Local)");
            assert.strictEqual(episode.plot, "Provider episode plot.");
            assert.deepStrictEqual(episode.still, {
              _tag: "Remote",
              url: "https://images.example/t/p/w300/s01e01.jpg",
            });
            assert.deepStrictEqual(episode.seasonPoster, {
              _tag: "Remote",
              url: "https://images.example/t/p/w500/season-1.jpg",
            });
            assert.deepStrictEqual(episode.ids, { tmdb: "1001", imdb: undefined, tvdb: undefined });
            assert.deepStrictEqual(episode.seasonIds.tmdb, "2001");
            assert.deepStrictEqual(
              episode.credits.map((credit) => [credit.name, credit.kind]),
              [
                ["Gus Guest", "guest-star"],
                ["Dana Keyframe", "director"],
                ["Wren Writer", "writer"],
              ],
            );
            assert.strictEqual(resolved.metadata.status, "returning");
            assert.deepStrictEqual(
              resolved.metadata.credits.map((credit) => credit.kind),
              ["actor", "creator", "producer"],
            );
          }),
        );
      });
    },
  );

  layer(Layer.provideMerge(pluginLayer(READ_TOKEN), baseLayer), { excludeTestServices: true })(
    "with a read access token",
    (it) => {
      it.effect("sends the token as a bearer header", () =>
        Effect.gen(function* () {
          const plugin = yield* MetadataPlugin.Service;
          const details = yield* plugin.titleDetails("show", "99999");

          assert.strictEqual(details.title, "Fixture Show");
        }),
      );
    },
  );

  const withoutKey = Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none())).pipe(
    Layer.provide(DiskCache.layer),
    Layer.provide(testConfigLayer({})),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

  layer(withoutKey, { excludeTestServices: true })("without an API key", (it) => {
    it.effect("reports itself unavailable and fails lookups with a typed error", () =>
      Effect.gen(function* () {
        const plugin = yield* MetadataPlugin.Service;

        assert.deepStrictEqual(yield* plugin.availability, {
          _tag: "Unavailable",
          reason: "missing-credentials",
        });

        const error = yield* plugin
          .search({ kind: "movie", title: "Anything", ids: {} })
          .pipe(Effect.flip);

        assert.instanceOf(error, MetadataPlugin.MetadataProviderUnavailable);
      }),
    );

    it.effect("refuses hosts the manifest does not list", () =>
      Effect.gen(function* () {
        const client = guardHosts(
          {
            id: "example",
            name: "Example",
            version: "1.0.0",
            role: "metadata",
            permissions: { hosts: ["api.example.org"], paths: [] },
          },
          yield* HttpClient.HttpClient,
        );

        const error = yield* client
          .execute(HttpClientRequest.get("http://127.0.0.1:9/"))
          .pipe(Effect.flip);

        assert.instanceOf(error, MetadataPlugin.PluginPermissionDenied);
      }),
    );
  });
});
