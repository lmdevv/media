import { get } from "node:http";
import { join } from "node:path";

import { serve } from "@hono/node-server";

import type { TrackId } from "@music/commands/ids";
import { FINISHED_PARAM } from "@music/commands/models";
import { fileRevision } from "@music/commands/revision";
import { signResource } from "@music/commands/signed-url";
import { describe, expect, it } from "vitest";
import { Duration, Effect, HashSet, Layer, Ref, Schedule } from "effect";
import type { Hono } from "hono";

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
import { canCountOpenFiles, openDescriptors } from "./testing/open-files.ts";
import { adtsPayload } from "./testing/adts.ts";
import { ffmpegFailingOnce } from "./testing/failing-ffmpeg.ts";
import { ffmpegHangingOnName } from "./testing/hanging-ffmpeg.ts";
import { ffmpegRecordingRuns } from "./testing/recording-ffmpeg.ts";
import {
  fragmentDecodeTimes,
  mediaData,
  topLevelBoxes,
  withoutIndex,
} from "./testing/mp4-boxes.ts";
import { sineSegment } from "./testing/sine.ts";
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

/** Serves `app` through `@hono/node-server` on a free local port until the scope closes. */
const listen = (app: Hono) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: ReturnType<typeof serve>; readonly port: number }>(
      (resume) => {
        const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
          resume(Effect.succeed({ server, port: info.port }));
        });
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => {
          resume(Effect.void);
        });
      }),
  ).pipe(Effect.map(({ port }) => port));

/**
 * A `GET` whose client goes away `afterMs` in, or as soon as the response starts when that comes
 * first.
 */
const abandonedGet = (port: number, path: string, afterMs: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const request = get({ host: "127.0.0.1", port, path });

    const leave = () => {
      clearTimeout(timer);
      request.destroy();
      resume(Effect.void);
    };

    const timer = setTimeout(leave, afterMs);

    request.on("response", leave);
    request.on("error", leave);
  });

/** A `GET` whose client goes away once the first piece of the body has arrived. */
const abandonedMidBody = (port: number, path: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const request = get({ host: "127.0.0.1", port, path });

    const leave = () => {
      request.destroy();
      resume(Effect.void);
    };

    request.on("response", (response) => {
      response.once("data", leave);
      response.once("end", leave);
    });
    request.on("error", leave);
  });

/** The whole body of a `GET` through a real socket. */
const fetchWhole = (port: number, path: string): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);

    return new Uint8Array(await response.arrayBuffer());
  });

/** A `GET` through a real socket. */
const fetchAt = (port: number, path: string): Effect.Effect<Response> =>
  Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`));

/** `url` asking for the finished file, as a download does. */
const finishedUrl = (url: string): string => `${url}&${FINISHED_PARAM}=1`;

/** Repeats `send` while it answers 503, as a download polls a file that is being prepared. */
const untilPrepared = (send: Effect.Effect<Response>): Effect.Effect<Response> =>
  send.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("50 millis"),
      until: (response) => response.status !== 503,
      times: 400,
    }),
  );

/** The app on a fresh fixture library, with `ffmpegPath` as its ffmpeg. */
const setupWith = Effect.fn("Test.setup")(function* (ffmpegPath: string) {
  const { root } = yield* fixtureLibrary;
  const dataDir = yield* temporaryDirectory("data");
  const config = testConfig(dataDir, undefined, ffmpegPath);

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

  const releasedArt = yield* Ref.make(HashSet.empty<string>());

  const scan = scanLibrary({ id: libraryId, path: root }, progress, releasedArt).pipe(
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
    app,
    root,
    dataDir,
    scan,
    libraryId,
    control,
    backend,
    trackId,
    findTrackId,
    artHash,
    request,
  };
});

const setup = setupWith("ffmpeg");

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

        // A download stores the file's revision and resumes with it as the validator.
        const { size, mtimeMs } = yield* Files.statPath(join(root, DAWN));
        const etag = response.headers.get("ETag") ?? "";

        expect(etag).toBe(`"${fileRevision(size, mtimeMs)}"`);
        const cached = yield* request(url, { headers: { "If-None-Match": etag } });

        expect(cached.status).toBe(304);

        const head = yield* request(url, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers.get("Content-Length")).toBe(String(file.length));
        expect((yield* bytes(head)).length).toBe(0);
      }),
    ));

  it("plays from a library whose folder is the file system root", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, control, backend, findTrackId, request } = yield* setup;
        const dawn = (yield* control.tracks).find((track) => track.scanned.path === DAWN);

        if (dawn === undefined) expect.unreachable("the fixture scan found no Dawn");
        const everything = yield* control.addLibrary("/");
        const fromRoot = join(root, DAWN).slice(1);

        yield* backend.upsertTracks(everything, [{ ...dawn.scanned, path: fromRoot }]);
        const response = yield* request(yield* streamUrl(yield* findTrackId(fromRoot), "original"));

        expect(response.status).toBe(200);
        expect(yield* bytes(response)).toEqual(
          new Uint8Array(yield* Files.readWholeFile(join(root, DAWN))),
        );
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

  it("serves finished AAC as a fast-start MP4 with validators and byte ranges", () =>
    runScoped(
      Effect.gen(function* () {
        const { dataDir, trackId, request } = yield* setup;
        const url = yield* streamUrl(trackId(DAWN), "aac-320");
        // HEAD waits for the finished file.
        const head = yield* request(url, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers.get("Content-Type")).toBe("audio/mp4");
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

        expect(head.headers.get("ETag")).toBe(etag);
        const ranged = yield* request(url, { headers: { Range: "bytes=0-99", "If-Range": etag } });

        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("ETag")).toBe(etag);

        // A media element's opening ranges get the finished file's bytes too.
        const opening = yield* request(url, { headers: { Range: "bytes=0-1" } });

        expect(opening.status).toBe(206);
        expect(opening.headers.get("Content-Range")).toBe(
          `bytes 0-1/${head.headers.get("Content-Length") ?? ""}`,
        );
      }),
    ));

  it("streams an AAC transcode as ADTS while it is written and shares it between requests", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, dataDir, scan, findTrackId, request } = yield* setup;

        // Two minutes of tone: ffmpeg is still encoding when the responses start.
        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 120);
        yield* scan;
        const id = yield* findTrackId("long.mp3");
        const url = yield* streamUrl(id, "aac-128");

        // Chromium and Firefox open a source with `bytes=0-`, Safari with `bytes=0-1`.
        const [plain, safari] = yield* Effect.all(
          [
            request(url, { headers: { Range: "bytes=0-" } }),
            request(url, { headers: { Range: "bytes=0-1" } }),
          ],
          { concurrency: 2 },
        );

        for (const live of [plain, safari]) {
          expect(live.status).toBe(200);
          expect(live.headers.get("Content-Type")).toBe("audio/aac");
          expect(live.headers.get("Cache-Control")).toBe("no-store");
          expect(live.headers.get("ETag")).toBeNull();
          expect(live.headers.get("Content-Length")).toBeNull();
          expect(live.headers.get("Accept-Ranges")).toBeNull();
          expect(live.headers.get("X-Music-Duration-Samples")).toBeNull();
        }

        const [one, two] = yield* Effect.all([bytes(plain), bytes(safari)], { concurrency: 2 });

        expect(Buffer.from(one).equals(two)).toBe(true);

        // Once the bodies end, the finished file answers, and it holds the same frames.
        const finished = yield* request(url);

        expect(finished.status).toBe(200);
        expect(finished.headers.get("Content-Type")).toBe("audio/mp4");
        expect(finished.headers.get("ETag")).not.toBeNull();
        const file = yield* bytes(finished);

        expect(finished.headers.get("Content-Length")).toBe(String(file.length));
        expect(adtsPayload(one)?.equals(mediaData(file))).toBe(true);

        const cached = yield* Files.listNames(join(dataDir, "cache", "aac-128"));

        expect(cached).toHaveLength(1);
        expect(cached[0]).toMatch(new RegExp(`^${id}-\\d+\\.m4a$`));
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

  it("streams a fragmented transcode as it is written, then serves the exact timing", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, dataDir, scan, findTrackId, request } = yield* setup;

        // Two minutes of tone: ffmpeg is still encoding when the response starts.
        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 120);
        yield* scan;
        const url = yield* streamUrl(yield* findTrackId("long.mp3"), "fmp4-aac");
        const live = yield* request(url, { headers: { Origin: "http://localhost:3001" } });

        expect(live.status).toBe(200);
        expect(live.headers.get("Content-Type")).toBe("audio/mp4");
        expect(live.headers.get("Cache-Control")).toBe("no-store");
        expect(live.headers.get("ETag")).toBeNull();
        expect(live.headers.get("X-Music-Duration-Estimated")).toBe("1");
        expect(live.headers.get("X-Music-Priming-Samples")).toBe("1024");
        expect(live.headers.get("X-Music-Sample-Rate")).toBe("48000");
        expect(live.headers.get("Access-Control-Expose-Headers")).toContain(
          "X-Music-Duration-Estimated",
        );

        const estimate = Number(live.headers.get("X-Music-Duration-Samples"));

        expect(Math.abs(estimate - 48_000 * 120)).toBeLessThan(4800);
        const streamed = yield* bytes(live);

        // Once the body ends, the finished file answers with the exact length.
        const head = yield* request(url, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers.get("X-Music-Duration-Estimated")).toBeNull();
        expect(head.headers.get("X-Music-Duration-Samples")).toBe(String(48_000 * 120));
        expect(head.headers.get("X-Music-Priming-Samples")).toBe("1024");
        expect(head.headers.get("ETag")).not.toBeNull();

        const finished = yield* request(url);
        const file = yield* bytes(finished);

        expect(finished.headers.get("X-Music-Duration-Estimated")).toBeNull();
        expect(finished.headers.get("Content-Length")).toBe(String(file.length));
        expect(Buffer.from(streamed).equals(withoutIndex(file))).toBe(true);

        const cached = yield* Files.listNames(join(dataDir, "cache", "fmp4-aac"));

        expect(cached.filter((name) => name.endsWith(".part"))).toEqual([]);
      }),
    ));

  it("keeps transcoding while a client has stopped reading the live stream", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, dataDir, scan, findTrackId, request } = yield* setup;

        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 120);
        yield* scan;
        const url = yield* streamUrl(yield* findTrackId("long.mp3"), "aac-128");
        const live = yield* request(url);

        expect(live.headers.get("Content-Type")).toBe("audio/aac");
        const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = live.body?.getReader();

        if (reader === undefined) throw new Error("Expected a body");

        const first = yield* Effect.promise(() => reader.read());

        // Like a paused or fully buffered media element: the client reads nothing more, and
        // the transcode still finishes into the cache.
        const cacheDir = join(dataDir, "cache", "aac-128");

        const cached = Files.listNames(cacheDir).pipe(
          Effect.map((names) => names.filter((name) => name.endsWith(".m4a"))),
        );

        for (let waited = 0; (yield* cached).length === 0 && waited < 300; waited += 1) {
          yield* Effect.sleep("100 millis");
        }

        expect(yield* cached).toHaveLength(1);

        // Then the client reads on and gets the whole stream.
        const rest: Array<Uint8Array> = [first.value ?? new Uint8Array()];

        for (;;) {
          const next = yield* Effect.promise(() => reader.read());

          if (next.done) break;
          rest.push(next.value);
        }

        const file = yield* bytes(yield* request(url));

        expect(adtsPayload(Buffer.concat(rest))?.equals(mediaData(file))).toBe(true);
      }),
    ));

  it("aborts a live stream whose transcode dies, and transcodes again on the next request", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("ffmpeg");
        const ffmpeg = yield* Effect.promise(() => ffmpegFailingOnce(scratch, 0.5));
        const { root, dataDir, scan, findTrackId, request } = yield* setupWith(ffmpeg);

        // Six minutes: ffmpeg is killed long before it finishes.
        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 360);
        yield* scan;
        const url = yield* streamUrl(yield* findTrackId("long.mp3"), "aac-128");
        const live = yield* request(url);

        expect(live.status).toBe(200);
        expect(live.headers.get("Content-Type")).toBe("audio/aac");

        // The body fails instead of ending as if the song were over.
        const read = yield* Effect.promise(() =>
          live.arrayBuffer().then(
            () => "ended",
            () => "aborted",
          ),
        );

        expect(read).toBe("aborted");
        const cacheDir = join(dataDir, "cache", "aac-128");

        expect(yield* Files.listNames(cacheDir)).toEqual([]);

        // Nothing half-done is cached: the next request starts a new transcode and gets it all.
        const again = yield* request(url);

        expect(again.headers.get("Content-Type")).toBe("audio/aac");
        const streamed = yield* bytes(again);
        const file = yield* bytes(yield* request(url));

        expect(adtsPayload(streamed)?.equals(mediaData(file))).toBe(true);
      }),
    ));

  it("starts a stream part-way into the song with the offset's timing", () =>
    runScoped(
      Effect.gen(function* () {
        const { dataDir, trackId, request } = yield* setup;
        const id = trackId(NEON);
        const aac = `${yield* streamUrl(id, "aac-128")}&start=1500`;

        const adts = yield* request(aac, {
          headers: { Origin: "http://localhost:3001", Range: "bytes=0-" },
        });

        expect(adts.status).toBe(200);
        expect(adts.headers.get("Content-Type")).toBe("audio/aac");
        expect(adts.headers.get("Cache-Control")).toBe("no-store");
        expect(adts.headers.get("Content-Length")).toBeNull();
        expect(adts.headers.get("Accept-Ranges")).toBeNull();
        expect(adts.headers.get("X-Music-Start-Samples")).toBe(String(1.5 * 44_100));
        expect(adts.headers.get("X-Music-Priming-Samples")).toBe("1024");
        expect(adts.headers.get("X-Music-Sample-Rate")).toBe("44100");
        expect(adts.headers.get("Access-Control-Expose-Headers")).toContain(
          "X-Music-Start-Samples",
        );
        expect(adtsPayload(yield* bytes(adts))?.length).toBeGreaterThan(0);

        const fragmented = yield* request(`${yield* streamUrl(id, "fmp4-aac")}&start=1500`);

        expect(fragmented.status).toBe(200);
        expect(fragmented.headers.get("Content-Type")).toBe("audio/mp4");
        expect(fragmented.headers.get("X-Music-Duration-Estimated")).toBe("1");
        const rate = Number(fragmented.headers.get("X-Music-Sample-Rate"));
        const start = String(1.5 * rate);

        expect(fragmented.headers.get("X-Music-Start-Samples")).toBe(start);
        expect(fragmentDecodeTimes(yield* bytes(fragmented))[0]).toBe(BigInt(start));

        // Offset streams are never cached.
        for (const profile of ["aac-128", "fmp4-aac"]) {
          expect(yield* Files.listNames(join(dataDir, "cache", profile))).toEqual([]);
        }
      }),
    ));

  it("checks offset requests like any other and rejects malformed offsets", () =>
    runScoped(
      Effect.gen(function* () {
        const { trackId, request } = yield* setup;
        const id = trackId(NEON);
        const valid = yield* streamUrl(id, "aac-128");

        // The offset does not widen what a signature grants: the same track, profile, and expiry.
        expect((yield* request(`${tamper(valid)}&start=1000`)).status).toBe(403);
        const expired = yield* streamUrl(id, "aac-128", Date.now() - 1000);

        expect((yield* request(`${expired}&start=1000`)).status).toBe(403);
        const other = (yield* streamUrl(trackId(DAWN), "aac-128")).replace(trackId(DAWN), id);

        expect((yield* request(`${other}&start=1000`)).status).toBe(403);

        for (const start of ["-1", "1.5", "abc", "", "1e3", "12345678901"]) {
          expect((yield* request(`${valid}&start=${start}`)).status).toBe(400);
        }

        // The original cannot start part-way; a zero offset is the plain request.
        const original = yield* streamUrl(id, "original");

        expect((yield* request(`${original}&start=1000`)).status).toBe(400);
        const plain = yield* request(`${original}&start=0`);

        expect(plain.status).toBe(200);
        expect(plain.headers.get("Accept-Ranges")).toBe("bytes");
      }),
    ));

  it("starts offsets only for a reading GET, and caps how many run at once", () =>
    runScoped(
      Effect.gen(function* () {
        const { trackId, request } = yield* setup;
        const id = trackId(NEON);
        const url = `${yield* streamUrl(id, "aac-128")}&start=1000`;

        // A HEAD body is never read, so an offset run started for it would never finish.
        expect((yield* request(url, { method: "HEAD" })).status).toBe(405);

        // Unread bodies hold their runs; one past the cap is turned away at once.
        const held = yield* Effect.forEach(
          Array.from({ length: Transcoder.MAX_CONCURRENT_OFFSET_RUNS }),
          () => request(url),
        );

        expect(held.map((response) => response.status)).toEqual(held.map(() => 200));
        const refused = yield* request(url, { headers: { Origin: "http://localhost:3001" } });

        expect(refused.status).toBe(503);
        expect(refused.headers.get("Retry-After")).toBe("2");
        expect(refused.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");

        // Ending one stream frees its run.
        yield* Effect.promise(async () => held[0]?.body?.cancel());
        yield* Effect.sleep(Duration.millis(200));
        const next = yield* request(url);

        expect(next.status).toBe(200);
        yield* Effect.promise(async () =>
          Promise.all(
            [...held.slice(1), next].map(
              (response) => response.body?.cancel() ?? Promise.resolve(),
            ),
          ),
        );
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

  it("answers a download with 503 while its file is prepared, then the finished file", () =>
    runScoped(
      Effect.gen(function* () {
        const { trackId, request } = yield* setup;
        const url = `${yield* streamUrl(trackId(DAWN), "aac-320")}&${FINISHED_PARAM}=1`;
        const preparing = yield* request(url, { headers: { Origin: "http://localhost:3001" } });

        expect(preparing.status).toBe(503);
        expect(preparing.headers.get("Retry-After")).toBe("2");
        expect(preparing.headers.get("Cache-Control")).toBe("no-store");
        expect(preparing.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");

        const response = yield* untilPrepared(request(url));

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("audio/mp4");
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        const body = yield* bytes(response);

        expect(response.headers.get("Content-Length")).toBe(String(body.length));
        // An MP4 with its index first, not the ADTS a live stream of this profile sends.
        const boxes = topLevelBoxes(body).map((box) => box.type);

        expect(boxes[0]).toBe("ftyp");
        expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));

        // A download resumes with a range and the validator it was given.
        const etag = response.headers.get("ETag") ?? "";

        expect(etag).not.toBe("");

        const resumed = yield* request(url, {
          headers: { Range: "bytes=100-", "If-Range": etag },
        });

        expect(resumed.status).toBe(206);
        expect(resumed.headers.get("Content-Range")).toBe(
          `bytes 100-${body.length - 1}/${body.length}`,
        );
        expect(yield* bytes(resumed)).toEqual(body.subarray(100));

        const head = yield* request(url, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers.get("ETag")).toBe(etag);
        expect((yield* bytes(head)).length).toBe(0);
      }),
    ));

  it("serves an original unchanged to a download, and refuses offsets and unknown flags", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, trackId, request } = yield* setup;
        const id = trackId(NEON);
        const original = yield* streamUrl(id, "original");
        const plain = yield* request(original);
        const downloaded = yield* request(`${original}&${FINISHED_PARAM}=1`);

        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get("ETag")).toBe(plain.headers.get("ETag"));
        expect(yield* bytes(downloaded)).toEqual(
          new Uint8Array(yield* Files.readWholeFile(join(root, NEON))),
        );

        const transcoded = yield* streamUrl(id, "aac-320");

        expect((yield* request(`${transcoded}&${FINISHED_PARAM}=1&start=1000`)).status).toBe(400);
        expect((yield* request(`${original}&${FINISHED_PARAM}=1&start=1000`)).status).toBe(400);
        expect((yield* request(`${transcoded}&${FINISHED_PARAM}=yes`)).status).toBe(400);
        expect((yield* request(`${transcoded}&${FINISHED_PARAM}=0`)).status).toBe(400);

        const expired = yield* streamUrl(id, "aac-320", Date.now() - 1000);

        expect((yield* request(`${expired}&${FINISHED_PARAM}=1`)).status).toBe(403);
      }),
    ));

  it("answers 502, never the original, when a download's transcode fails", () =>
    runScoped(
      Effect.gen(function* () {
        const { root, libraryId, backend, findTrackId, request } = yield* setup;
        const junk = new TextEncoder().encode("this is not really an audio file");

        yield* Files.writeFileAtomic(join(root, "junk.mp3"), junk, "a");
        yield* backend.upsertTracks(libraryId, [
          {
            path: "junk.mp3",
            size: junk.length,
            mtimeMs: 1,
            title: "junk",
            artist: "Nobody",
            album: "Junk",
            durationMs: 1000,
            codec: "mp3",
            lossless: false,
          },
        ]);

        const url = `${yield* streamUrl(yield* findTrackId("junk.mp3"), "aac-128")}&${FINISHED_PARAM}=1`;

        expect((yield* untilPrepared(request(url))).status).toBe(502);
        // Remembered for a while, so every poller hears it.
        expect((yield* request(url)).status).toBe(502);
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

describe("media HTTP server", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("releases a live transcode whose clients go away before or while it streams", () =>
    runScoped(
      Effect.gen(function* () {
        const { app, root, dataDir, scan, findTrackId } = yield* setup;

        // Two minutes of tone: ffmpeg is still encoding while the clients come and go.
        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 120);
        yield* scan;
        const url = yield* streamUrl(yield* findTrackId("long.mp3"), "aac-128");
        const port = yield* listen(app);

        // Most leave while the transcode starts, before its body streams; the rest once it has.
        yield* Effect.forEach(
          [5, 10, 15, 20, 30, 50, 200, 400],
          (afterMs) => abandonedGet(port, url, afterMs),
          { concurrency: "unbounded" },
        );

        // A client that stays reads the transcode to its end.
        expect((yield* fetchWhole(port, url)).length).toBeGreaterThan(0);

        // With no reader left, the live copy goes. A hold kept by a client that went away would
        // keep it, and its ffmpeg, forever.
        const liveFiles = Files.listNames(join(dataDir, "cache", "aac-128")).pipe(
          Effect.map((names) => names.filter((name) => name.includes(".live"))),
        );

        const remaining = yield* liveFiles.pipe(
          Effect.repeat({
            until: (names) => names.length === 0,
            schedule: Schedule.spaced("100 millis"),
            times: 50,
          }),
        );

        expect(remaining).toEqual([]);
      }),
    ));

  it.skipIf(!canCountOpenFiles())(
    "closes original and finished files whose clients go away before or while they stream",
    () =>
      runScoped(
        Effect.gen(function* () {
          const { app, root, dataDir, scan, findTrackId } = yield* setup;

          // Two minutes of tone: more than a socket buffers, so a client that leaves mid-way
          // leaves the rest of the file unread.
          yield* sineSegment(root, "long", "flac", 0, 48_000 * 120);
          yield* scan;
          const id = yield* findTrackId("long.flac");
          const original = yield* streamUrl(id, "original");
          const finished = yield* streamUrl(id, "aac-320");
          const port = yield* listen(app);

          // HEAD waits for the finished transcode, which a GET then serves as a file.
          yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}${finished}`, { method: "HEAD" }),
          );
          const [cached] = yield* Files.listNames(join(dataDir, "cache", "aac-320"));

          if (cached === undefined) expect.unreachable("the transcode was not cached");
          const files = [join(root, "long.flac"), join(dataDir, "cache", "aac-320", cached)];

          yield* Effect.forEach(
            [original, finished].flatMap((url) =>
              [0, 1, 2, 5, 10, 50].map((afterMs) => ({ url, afterMs })),
            ),
            ({ url, afterMs }) => abandonedGet(port, url, afterMs),
            { concurrency: "unbounded" },
          );

          // And some while the body streams, after its first bytes.
          yield* Effect.forEach(
            [original, finished, original, finished],
            (url) => abandonedMidBody(port, url),
            { concurrency: "unbounded" },
          );

          const open = yield* Effect.forEach(files, (path) =>
            Effect.promise(() => openDescriptors(path)).pipe(
              Effect.repeat({
                until: (count) => count === 0,
                schedule: Schedule.spaced("50 millis"),
                times: 60,
              }),
            ),
          );

          expect(open).toEqual([0, 0]);
        }),
      ),
  );

  it("keeps preparing a download whose client goes away, in a lane listeners never wait for", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("ffmpeg");
        const ffmpeg = yield* Effect.promise(() => ffmpegHangingOnName(scratch));
        const { app, root, scan, findTrackId, trackId } = yield* setupWith(ffmpeg.path);

        // A song whose encode never ends: it holds the prepare lane for the whole test.
        yield* sineSegment(root, "hang-download", "mp3", 0, 48_000);
        yield* scan;
        const port = yield* listen(app);
        const id = yield* findTrackId("hang-download.mp3");
        const download = finishedUrl(yield* streamUrl(id, "aac-320"));
        const started = Effect.promise(ffmpeg.started);
        const before = yield* started;

        // One ask starts the run; the clients after it leave at every point of their request.
        expect((yield* fetchAt(port, download)).status).toBe(503);
        yield* Effect.forEach([0, 1, 5, 20], (afterMs) => abandonedGet(port, download, afterMs), {
          concurrency: "unbounded",
        });

        // Past the second a stream nobody reads is given, the one run still goes, and asking
        // again joins it.
        yield* Effect.sleep("1500 millis");
        expect(yield* Effect.promise(ffmpeg.running)).toBe(1);
        expect((yield* fetchAt(port, download)).status).toBe(503);
        expect(yield* started).toBe(before + 1);

        // A second download waits for the lane without starting ffmpeg, while a listener streams
        // the same song at once, and the download then finds the listener's finished file.
        const dawn = yield* streamUrl(trackId(DAWN), "aac-320");

        expect((yield* fetchAt(port, finishedUrl(dawn))).status).toBe(503);
        expect(yield* started).toBe(before + 1);
        expect((yield* fetchWhole(port, dawn)).length).toBeGreaterThan(0);
        const ready = yield* untilPrepared(fetchAt(port, finishedUrl(dawn)));

        expect(ready.status).toBe(200);
        expect(topLevelBoxes(yield* bytes(ready))[0]?.type).toBe("ftyp");
        expect(yield* started).toBe(before + 2);
      }),
    ));

  it("frees the run of every seek whose client goes away before it streams", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("ffmpeg");
        const ffmpeg = yield* Effect.promise(() => ffmpegRecordingRuns(scratch));
        const { app, root, scan, findTrackId } = yield* setupWith(ffmpeg.path);

        // Two minutes of tone: an unread offset run fills its pipe and blocks long before the end.
        yield* sineSegment(root, "long", "mp3", 0, 48_000 * 120);
        yield* scan;
        const url = `${yield* streamUrl(yield* findTrackId("long.mp3"), "aac-128")}&start=1000`;
        const port = yield* listen(app);

        // As many seeks as there are runs, each left while ffprobe and ffmpeg start.
        yield* Effect.forEach(
          Array.from(
            { length: Transcoder.MAX_CONCURRENT_OFFSET_RUNS },
            (_, index) => 5 + 2 * index,
          ),
          (afterMs) => abandonedGet(port, url, afterMs),
          { concurrency: "unbounded" },
        );

        // Every ffmpeg they started is stopped.
        const running = yield* Effect.promise(ffmpeg.running).pipe(
          Effect.repeat({
            until: (pids) => pids.length === 0,
            schedule: Schedule.spaced("100 millis"),
            times: 50,
          }),
        );

        expect(running).toEqual([]);

        // And every run is free again: the next seek gets one instead of a 503.
        const next = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${url}`)).pipe(
          Effect.repeat({
            until: (response) => response.status !== 503,
            schedule: Schedule.spaced("100 millis"),
            times: 20,
          }),
        );

        expect(next.status).toBe(200);
        expect((yield* bytes(next)).length).toBeGreaterThan(0);
        expect(yield* Effect.promise(ffmpeg.running)).toEqual([]);
      }),
    ));
});
