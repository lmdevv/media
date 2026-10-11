import { join } from "node:path";

import type { TrackId } from "@music/commands/ids";
import { signResource } from "@music/commands/signed-url";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Ref } from "effect";

import packageJson from "../package.json" with { type: "json" };
import * as Files from "./files.ts";
import { makeHttpApp } from "./http-app.ts";
import { MediaBackend, type JobProgress, type ScannedTrack } from "./media-backend.ts";
import { scanLibrary } from "./scan.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  probe,
  temporaryDirectory,
  TEST_SIGNING_KEY,
  testConfig,
} from "./testing/fixtures.ts";
import { layerMemory, MemoryMediaBackendControl } from "./testing/memory-media-backend.ts";
import * as Transcoder from "./transcoder.ts";
import { runScoped } from "./testing/run.ts";

const DAWN = "Aurora Tones/First Light/01 Dawn.flac";

const NEON = "Aurora Tones/Night Drive/01 Neon.mp3";

const streamUrl = (
  id: string,
  profile: string,
  expiresAt = Date.now() + 60_000,
): Effect.Effect<string> =>
  Effect.promise(() =>
    signResource(TEST_SIGNING_KEY, { kind: "stream", trackId: id, profile }, expiresAt),
  ).pipe(Effect.map((sig) => `/media/stream/${id}?p=${profile}&exp=${expiresAt}&sig=${sig}`));

const artUrl = (hash: string): Effect.Effect<string> => {
  const expiresAt = Date.now() + 60_000;

  return Effect.promise(() =>
    signResource(TEST_SIGNING_KEY, { kind: "art", hash }, expiresAt),
  ).pipe(Effect.map((sig) => `/media/art/${hash}?exp=${expiresAt}&sig=${sig}`));
};

/** Changes the last character of a signed URL, which is always part of the signature. */
const tamper = (url: string): string => `${url.slice(0, -1)}${url.endsWith("A") ? "B" : "A"}`;

const bytes = (response: Response): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => new Uint8Array(await response.arrayBuffer()));

const setup = Effect.gen(function* () {
  const { root } = yield* fixtureLibrary;
  const dataDir = yield* temporaryDirectory("data");
  const config = testConfig(dataDir);

  const services = Layer.mergeAll(
    layerMemory,
    config,
    Transcoder.layer.pipe(Layer.provide(config)),
  );

  const context = yield* Layer.build(services);
  const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
  const backend = yield* MediaBackend.pipe(Effect.provideContext(context));
  const libraryId = yield* control.addLibrary(root);
  const progress = yield* Ref.make<JobProgress>({ done: 0 });

  const scan = scanLibrary({ id: libraryId, path: root }, progress).pipe(
    Effect.provideContext(context),
  );

  yield* scan;
  const app = yield* makeHttpApp.pipe(Effect.provideContext(context));
  const tracks = yield* control.tracks;

  const trackId = (path: string): TrackId => {
    const track = tracks.find((candidate) => candidate.scanned.path === path);

    if (track === undefined) throw new Error(`Fixture track missing: ${path}`);

    return track.id;
  };

  const artHash = (path: string): string =>
    tracks.find((track) => track.scanned.path === path)?.scanned.artHash ?? "";

  const request = (path: string, init?: RequestInit): Effect.Effect<Response> =>
    Effect.promise(async () => app.request(path, init));

  const findTrackId = (path: string): Effect.Effect<string> =>
    control.tracks.pipe(
      Effect.map((all) => all.find((track) => track.scanned.path === path)?.id ?? "unknown"),
    );

  return {
    root,
    dataDir,
    scan,
    libraryId,
    backend,
    trackId,
    findTrackId,
    artHash,
    request,
  };
});

describe("media HTTP API", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("reports health", () =>
    runScoped(
      Effect.gen(function* () {
        const { request } = yield* setup;
        const response = yield* request("/media/health");

        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          ok: true,
          convex: true,
          ffmpeg: true,
          version: packageJson.version,
        });
      }),
    ));

  it("plays an original file with validators and CORS headers", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, trackId, request } = yield* setup;
        const file = new Uint8Array(yield* Files.readWholeFile(join(root, DAWN)));
        const url = yield* streamUrl(trackId(DAWN), "original");
        const response = yield* request(url, { headers: { Origin: "http://localhost:3001" } });

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("audio/flac");
        expect(response.headers.get("Content-Length")).toBe(String(file.length));
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
        expect(yield* bytes(response)).toEqual(file);

        const etag = response.headers.get("ETag") ?? "";
        const cached = yield* request(url, { headers: { "If-None-Match": etag } });

        expect(cached.status).toBe(304);

        const head = yield* request(url, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers.get("Content-Length")).toBe(String(file.length));
        expect((yield* bytes(head)).length).toBe(0);
      }),
    ));

  it("serves byte ranges, suffix ranges, and 416 past the end", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, trackId, request } = yield* setup;
        const file = new Uint8Array(yield* Files.readWholeFile(join(root, NEON)));
        const url = yield* streamUrl(trackId(NEON), "original");
        const partial = yield* request(url, { headers: { Range: "bytes=100-199" } });

        expect(partial.status).toBe(206);
        expect(partial.headers.get("Content-Type")).toBe("audio/mpeg");
        expect(partial.headers.get("Content-Range")).toBe(`bytes 100-199/${file.length}`);
        expect(partial.headers.get("Content-Length")).toBe("100");
        expect(yield* bytes(partial)).toEqual(file.subarray(100, 200));

        const suffix = yield* request(url, { headers: { Range: "bytes=-50" } });

        expect(suffix.status).toBe(206);
        expect(yield* bytes(suffix)).toEqual(file.subarray(file.length - 50));

        const beyond = yield* request(url, { headers: { Range: `bytes=${file.length}-` } });

        expect(beyond.status).toBe(416);
        expect(beyond.headers.get("Content-Range")).toBe(`bytes */${file.length}`);

        const stale = yield* request(url, {
          headers: { Range: "bytes=0-9", "If-Range": '"stale"' },
        });

        expect(stale.status).toBe(200);
        expect((yield* bytes(stale)).length).toBe(file.length);
      }),
    ));

  it("rejects bad signatures and unknown tracks", () =>
    runScoped(
      Effect.gen(function* () {
        const { trackId, request } = yield* setup;
        const id = trackId(DAWN);
        const valid = yield* streamUrl(id, "original");

        expect((yield* request(tamper(valid))).status).toBe(403);
        expect((yield* request(yield* streamUrl(id, "original", Date.now() - 1000))).status).toBe(
          403,
        );
        expect((yield* request(valid.replace("p=original", "p=aac-128"))).status).toBe(403);
        expect((yield* request(yield* streamUrl("track999", "original"))).status).toBe(404);
        expect((yield* request(yield* streamUrl(id, "flac-lossless"))).status).toBe(400);
      }),
    ));

  it("transcodes to playable AAC and shares one transcode between concurrent requests", () =>
    runScoped(
      Effect.gen(function* () {
        const { dataDir, trackId, request } = yield* setup;
        const url = yield* streamUrl(trackId(DAWN), "aac-320");
        const response = yield* request(url);

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("audio/mp4");
        const output = join(dataDir, "probe.m4a");
        yield* Files.writeFileAtomic(output, yield* bytes(response), "probe");
        const probed = yield* probe(output);

        expect(probed.format.format_name).toContain("mp4");
        expect(probed.streams).toMatchObject([
          { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
        ]);
        expect(Number(probed.format.duration)).toBeCloseTo(4, 0);

        // Serving again marks the cache entry used without changing its validators, so a player
        // that seeks with If-Range keeps getting partial content.
        const etag = response.headers.get("ETag") ?? "";
        const ranged = yield* request(url, { headers: { Range: "bytes=0-99", "If-Range": etag } });

        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("ETag")).toBe(etag);

        const lowUrl = yield* streamUrl(trackId(NEON), "aac-128");

        const [first, second] = yield* Effect.all([request(lowUrl), request(lowUrl)], {
          concurrency: 2,
        });

        expect(first.status).toBe(200);
        expect(yield* bytes(first)).toEqual(yield* bytes(second));
        const cached = yield* Files.listNames(join(dataDir, "cache", "aac-128"));

        expect(cached).toHaveLength(1);
        expect(cached[0]).toMatch(new RegExp(`^${trackId(NEON)}-\\d+\\.m4a$`));
      }),
    ));

  it("serves fragmented profiles with sample timing headers that CORS exposes", () =>
    runScoped(
      Effect.gen(function* () {
        const { trackId, request } = yield* setup;
        const flacUrl = yield* streamUrl(trackId(DAWN), "fmp4-flac");
        const flac = yield* request(flacUrl, { headers: { Origin: "http://localhost:3001" } });

        expect(flac.status).toBe(200);
        expect(flac.headers.get("Content-Type")).toBe("audio/mp4");
        expect(flac.headers.get("X-Music-Priming-Samples")).toBe("0");
        expect(Number(flac.headers.get("X-Music-Duration-Samples"))).toBeGreaterThan(0);
        expect(flac.headers.get("X-Music-Sample-Rate")).toBe("44100");

        const exposed = flac.headers.get("Access-Control-Expose-Headers") ?? "";

        for (const name of [
          "X-Music-Priming-Samples",
          "X-Music-Duration-Samples",
          "X-Music-Sample-Rate",
        ]) {
          expect(exposed).toContain(name);
        }

        // Ranged requests carry the timing too, so a seek can re-read it.
        const ranged = yield* request(yield* streamUrl(trackId(NEON), "fmp4-aac"), {
          headers: { Range: "bytes=0-99" },
        });

        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("X-Music-Priming-Samples")).toBe("1024");
      }),
    ));

  it("answers 502 instead of the original when a fragmented transcode fails", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, libraryId, backend, findTrackId, request } = yield* setup;
        const junk = new TextEncoder().encode("this is not really an audio file");

        yield* Files.writeFileAtomic(join(root, "junk.flac"), junk, "a");
        yield* backend.upsertTracks(libraryId, [
          {
            path: "junk.flac",
            size: junk.length,
            mtimeMs: 1,
            title: "junk",
            artist: "Nobody",
            album: "Junk",
            durationMs: 1000,
            codec: "flac",
            lossless: true,
          },
        ]);

        const response = yield* request(
          yield* streamUrl(yield* findTrackId("junk.flac"), "fmp4-flac"),
        );

        expect(response.status).toBe(502);
      }),
    ));

  it("falls back to the original when a browser-playable file cannot be transcoded", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, libraryId, backend, findTrackId, request } = yield* setup;
        const junk = new TextEncoder().encode("this is not really an audio file");

        const fake = (path: string, codec: string): ScannedTrack => ({
          path,
          size: junk.length,
          mtimeMs: 1,
          title: path,
          artist: "Nobody",
          album: "Junk",
          durationMs: 1000,
          codec,
          lossless: false,
        });

        yield* Files.writeFileAtomic(join(root, "junk.mp3"), junk, "a");
        yield* Files.writeFileAtomic(join(root, "junk.wma"), junk, "b");
        yield* backend.upsertTracks(libraryId, [fake("junk.mp3", "mp3"), fake("junk.wma", "wma")]);

        const playable = yield* request(
          yield* streamUrl(yield* findTrackId("junk.mp3"), "aac-128"),
        );

        expect(playable.status).toBe(200);
        expect(playable.headers.get("Content-Type")).toBe("audio/mpeg");
        expect(yield* bytes(playable)).toEqual(junk);

        const unplayable = yield* request(
          yield* streamUrl(yield* findTrackId("junk.wma"), "aac-128"),
        );

        expect(unplayable.status).toBe(502);
      }),
    ));

  it("answers 404 when a catalogued file is gone from disk", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, trackId, request } = yield* setup;
        const url = yield* streamUrl(trackId(NEON), "original");

        yield* Files.removePath(join(root, NEON));
        expect((yield* request(url)).status).toBe(404);
      }),
    ));

  it("refuses to serve a catalogued file that became a symlink out of the library", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, trackId, request } = yield* setup;
        const outside = yield* temporaryDirectory("outside");
        const secret = join(outside, "secret.mp3");
        const original = yield* streamUrl(trackId(NEON), "original");
        const transcoded = yield* streamUrl(trackId(NEON), "aac-128");

        yield* Files.copyTree(join(root, NEON), secret);
        yield* Files.removePath(join(root, NEON));
        yield* Files.makeSymlink(secret, join(root, NEON));

        expect((yield* request(original)).status).toBe(404);
        expect((yield* request(transcoded)).status).toBe(404);
      }),
    ));

  it("treats file names as names, never as ffmpeg options or protocols", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, scan, findTrackId, request } = yield* setup;
        const hostile = "-y -f lavfi -i concat:a.mp3|file:b.mp3";

        yield* Files.copyTree(join(root, NEON), join(root, hostile));
        yield* scan;

        const id = yield* findTrackId(hostile);

        for (const profile of ["aac-128", "fmp4-aac"]) {
          const response = yield* request(yield* streamUrl(id, profile));

          expect(response.status).toBe(200);
          expect((yield* bytes(response)).length).toBeGreaterThan(1000);
        }
      }),
    ));

  it("serves signed artwork as immutable", () =>
    runScoped(
      Effect.gen(function* () {
        const { artHash, request, dataDir } = yield* setup;
        const hash = artHash(NEON);
        const url = yield* artUrl(hash);
        const response = yield* request(url);

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/jpeg");
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
        expect(yield* bytes(response)).toEqual(
          new Uint8Array(yield* Files.readWholeFile(join(dataDir, "art", hash))),
        );

        expect((yield* request(tamper(url))).status).toBe(403);
        expect((yield* request(yield* artUrl("0".repeat(64)))).status).toBe(404);
        expect((yield* request(yield* artUrl("../../etc/passwd"))).status).toBe(404);
      }),
    ));
});
