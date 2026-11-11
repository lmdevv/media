import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Option, Result, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import { LibraryId, PlaybackSessionId } from "@media/contracts/ids";

import { timelineOf } from "../diagnostics/timeline.ts";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg, writeSlowFfprobe } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";
import * as PlaybackReporter from "./playback-reporter.ts";

const hasFfmpeg = await ffmpegAvailable();

const failingQsv = await writeFakeFfmpeg({
  qsvFailsAfterSeconds: 6,
});

const slowStart = await writeFakeFfmpeg({ hlsDelayMs: 10_000 });

const slowQsv = await writeFakeFfmpeg({ hlsDelayMs: 3000, qsvFailsAfterSeconds: 0 });

const slowHardwareStart = await writeFakeFfmpeg({
  hlsDelayMs: 10_000,
  qsvFailsFromSeconds: 100_000,
});

const brokenStart = await writeFakeFfmpeg({ hlsFailsAtStart: true });

const damagedEnd = await writeFakeFfmpeg({ hlsFailsFromSeconds: 6, hlsFromStartSeconds: 1 });

const slowScan = await writeSlowFfprobe(12_000);

const TS_LIBRARY = LibraryId.make("transport-streams");

const TS_FILE = "Transport (2020)/Transport (2020).ts";

const addTransportStream = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const root = join(workspace.root, "transport");
  const output = join(root, TS_FILE);

  yield* fs.makeDirectory(join(root, "Transport (2020)"), { recursive: true });
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    join(workspace.library.moviesRoot, workspace.library.directMovie),
    "-c",
    "copy",
    "-f",
    "mpegts",
    output,
  ]);
  yield* scanner.scan({ libraryId: TS_LIBRARY, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(TS_LIBRARY, TS_FILE);
});

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const FIRST_RUN_FOLDER = /\/transcode\/[^/]+\/1$/u;

const listings = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextFirstRunListing = Effect.sync(() => {
  listings.armed = true;
  listings.reached = Promise.withResolvers<void>();
  listings.release = Promise.withResolvers<void>();
});

const listingsUntilRunStops = {
  fileSystem: (real: FileSystem.FileSystem) =>
    FileSystem.FileSystem.of({
      ...real,
      readDirectory: (directory, options) =>
        listings.armed && FIRST_RUN_FOLDER.test(directory)
          ? Effect.suspend(() => {
              listings.armed = false;
              listings.reached.resolve();

              return Effect.promise(() => listings.release.promise);
            }).pipe(Effect.andThen(real.readDirectory(directory, options)))
          : real.readDirectory(directory, options),
    }),
  mediaTools: (real: MediaTools.Interface) =>
    MediaTools.Service.of({
      ...real,
      startFfmpeg: (args) =>
        Effect.addFinalizer(() => Effect.sync(() => listings.release.resolve())).pipe(
          Effect.andThen(real.startFfmpeg(args)),
        ),
    }),
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const negotiateRequest = (baseUrl: string, token: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
    ),
  );

const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

const streamFolders = Effect.fn(function* () {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readDirectory(server.transcodeDir).pipe(Effect.orElseSucceed(() => []));
});

const awaitNoStreams = (within: Duration.Input) =>
  Effect.gen(function* () {
    for (;;) {
      if ((yield* streamFolders()).length === 0) return;
      yield* Effect.sleep(Duration.millis(50));
    }
  }).pipe(Effect.timeout(within), Effect.orDie);

describe.skipIf(!hasFfmpeg)("stream failures", () => {
  layer(MediaTestServer.layer({ FFMPEG_PATH: failingQsv, HARDWARE_ACCELERATION: "qsv" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "restarts a failed Quick Sync run once when several requests wait on it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "qsv",
          });

          const response = yield* negotiateRequest(server.baseUrl, token).pipe(Effect.orDie);

          const body = yield* response.json.pipe(Effect.orDie);

          assert.strictEqual(response.status, 200, JSON.stringify(body));
          const negotiated = yield* decodeNegotiation(body).pipe(Effect.orDie);

          assert.strictEqual(negotiated.mode, "transcode-qsv");
          assert.strictEqual(negotiated.generation, 1);
          const playlist = new URL(local(server.baseUrl, negotiated.url));
          const fs = yield* FileSystem.FileSystem;
          const runList = join(server.transcodeDir, negotiated.streamId ?? "", "1", "ffmpeg.m3u8");

          yield* fs.readFileString(runList).pipe(
            Effect.filterOrFail((text) => text.includes("#EXT-X-ENDLIST")),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout(Duration.seconds(20)),
            Effect.orDie,
          );

          const answers = yield* Effect.forEach(
            [5, 5, 5],
            (index) =>
              HttpClient.get(new URL(`${index}.m4s${playlist.search}`, playlist).toString()).pipe(
                Effect.flatMap((segment) =>
                  segment.json.pipe(Effect.map((error) => ({ status: segment.status, error }))),
                ),
                Effect.orDie,
              ),
            { concurrency: "unbounded" },
          );

          for (const answer of answers) {
            assert.strictEqual(answer.status, 410, JSON.stringify(answer.error));
            assert.deepInclude(answer.error, {
              _tag: "StreamGenerationGone",
              generation: 1,
              currentGeneration: 2,
            });
          }

          const changes = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.ModeChanged,
          );

          assert.strictEqual(changes.length, 1);
          assert.deepInclude(changes[0], { from: "transcode-qsv", to: "transcode-software" });

          const folder = join(server.transcodeDir, negotiated.streamId ?? "");

          const left = yield* fs.readDirectory(folder).pipe(
            Effect.repeat({
              until: (names) => names.length === 1 && names[0] === "2",
              schedule: Schedule.spaced("50 millis"),
              times: 100,
            }),
          );

          assert.deepStrictEqual(left, ["2"]);
        }),
      30_000,
    );
  });

  layer(
    MediaTestServer.layer({
      FFMPEG_PATH: slowQsv,
      HARDWARE_ACCELERATION: "qsv",
      MAX_CONCURRENT_TRANSCODES: "1",
      STREAM_IDLE_SECONDS: "600",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "stops the stream and frees its slot when the caller leaves before it starts",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;
          const fileId = server.fileId("movies", library.directMovie);

          const abandoned = yield* negotiateRequest(
            server.baseUrl,
            signTestToken({ fid: fileId, sid: "abandoned" }),
          ).pipe(Effect.timeout(Duration.millis(800)), Effect.result);

          assert.isTrue(Result.isFailure(abandoned));

          yield* awaitNoStreams(Duration.seconds(2));

          const ended = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.StreamEnded,
          );

          assert.deepStrictEqual(
            ended.map((event) => event.reason),
            ["abandoned"],
          );

          const next = yield* negotiateRequest(
            server.baseUrl,
            signTestToken({ fid: fileId, sid: "next" }),
          ).pipe(Effect.orDie);

          assert.strictEqual(next.status, 200);
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: slowQsv, HARDWARE_ACCELERATION: "qsv" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "answers a negotiation replaced while it waits, and leaves no folder behind",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);
          const token = signTestToken({ fid: fileId, sid: "replaced" });

          const before = yield* streamFolders();

          const request = HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(Effect.orDie);

          const [first, second] = yield* Effect.all(
            [request, request.pipe(Effect.delay(Duration.millis(500)))],
            { concurrency: "unbounded" },
          );

          assert.strictEqual(first.status, 404);
          assert.deepInclude(yield* first.json.pipe(Effect.orDie), { _tag: "StreamNotFound" });
          assert.strictEqual(second.status, 200);

          const negotiated = yield* decodeNegotiation(yield* second.json.pipe(Effect.orDie)).pipe(
            Effect.orDie,
          );

          assert.sameMembers(yield* streamFolders(), [...before, negotiated.streamId ?? ""]);
        }),
      30_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: slowHardwareStart, HARDWARE_ACCELERATION: "qsv" },
      listingsUntilRunStops,
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "answers a negotiation replaced while it reads its run's folder",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "replaced-mid-read",
          });

          yield* stallNextFirstRunListing;

          const first = yield* negotiateRequest(server.baseUrl, token).pipe(
            Effect.orDie,
            Effect.forkChild,
          );

          yield* Effect.promise(() => listings.reached.promise);

          const second = yield* negotiateRequest(server.baseUrl, token).pipe(Effect.orDie);
          const replaced = yield* Fiber.join(first);

          assert.strictEqual(replaced.status, 404);
          assert.deepInclude(yield* replaced.json.pipe(Effect.orDie), { _tag: "StreamNotFound" });
          assert.strictEqual(second.status, 200);
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ FFPROBE_PATH: slowScan }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "encodes while a slow keyframe scan runs, and copies once the scan is cached",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fileId = yield* addTransportStream.pipe(Effect.orDie);

          const fullScreen: ClientCapabilities = {
            containers: ["mp4"],
            videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
            audioCodecs: [{ codec: "aac" }],
            maxWidth: 1920,
            maxHeight: 1080,
            hls: false,
            mse: true,
          };

          const negotiate = (sid: string) =>
            HttpClient.execute(
              HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  token: signTestToken({ fid: fileId, sid }),
                  capabilities: fullScreen,
                }),
              ),
            ).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeNegotiation),
              Effect.orDie,
              Effect.timed,
            );

          const [took, first] = yield* negotiate("first");

          assert.strictEqual(first.mode, "transcode-software");
          assert.isBelow(Duration.toMillis(took), 10_000);

          yield* Effect.sleep(Duration.seconds(12));

          const [, later] = yield* negotiate("later");

          assert.strictEqual(later.mode, "remux");
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: slowStart }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "answers a software negotiation before the encoder writes anything",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiation = yield* negotiateRequest(server.baseUrl, token).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
            Effect.timed,
          );

          const [took, negotiated] = negotiation;

          assert.strictEqual(negotiated.mode, "transcode-software");
          assert.isBelow(Duration.toMillis(took), 8000);

          const playlist = new URL(local(server.baseUrl, negotiated.url));

          const first = yield* HttpClient.get(
            new URL(`0.m4s${playlist.search}`, playlist).toString(),
          );

          assert.strictEqual(first.status, 200);
          assert.isAbove((yield* first.arrayBuffer.pipe(Effect.orDie)).byteLength, 0);
        }),
      60_000,
    );

    it.effect(
      "keeps a starting generation when the player asks a few segments ahead",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "prefetch",
          });

          const negotiated = yield* negotiateRequest(server.baseUrl, token).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          const playlist = new URL(local(server.baseUrl, negotiated.url));

          const ahead = yield* HttpClient.get(
            new URL(`3.m4s${playlist.search}`, playlist).toString(),
          ).pipe(Effect.orDie);

          assert.strictEqual(ahead.status, 200);
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "never cuts a segment short when a seek deletes its generation",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.remuxMovie),
            sid: "race",
          });

          const remux: ClientCapabilities = {
            containers: [],
            videoCodecs: [{ codec: "h264" }],
            audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }],
            maxWidth: 1920,
            maxHeight: 1080,
            hls: false,
            mse: true,
          };

          for (let round = 0; round < 8; round += 1) {
            const started = yield* HttpClient.execute(
              HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ token, capabilities: remux, startSeconds: 9 }),
              ),
            ).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeNegotiation),
              Effect.orDie,
            );

            const playlist = new URL(local(server.baseUrl, started.url));

            const [segment] = yield* Effect.all(
              [
                HttpClient.get(new URL(`2.m4s${playlist.search}`, playlist).toString()).pipe(
                  Effect.flatMap((response) =>
                    response.arrayBuffer.pipe(
                      Effect.map((body) => ({
                        status: response.status,
                        length: body.byteLength,
                        declared: Number(response.headers["content-length"]),
                      })),
                    ),
                  ),
                  Effect.orDie,
                ),
                HttpClient.execute(
                  HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      token,
                      streamId: started.streamId,
                      positionSeconds: 0,
                    }),
                  ),
                ).pipe(Effect.orDie),
              ],
              { concurrency: "unbounded" },
            );

            if (segment.status === 200) {
              assert.isAbove(segment.length, 0);
              assert.strictEqual(segment.length, segment.declared);
            } else {
              assert.include([410, 503], segment.status);
            }
          }
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ MIN_FREE_TRANSCODE_MB: "1000000000" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "refuses a stream while the transcode folder is too full, and keeps no slot",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);

          for (const sid of ["full-1", "full-2", "full-3", "full-4"]) {
            const response = yield* negotiateRequest(
              server.baseUrl,
              signTestToken({ fid: fileId, sid }),
            ).pipe(Effect.orDie);

            assert.strictEqual(response.status, 507);
            assert.deepInclude(yield* response.json.pipe(Effect.orDie), {
              _tag: "InsufficientTranscodeSpace",
              requiredBytes: 1_000_000_000 * 1024 * 1024,
            });
          }

          assert.deepStrictEqual(yield* streamFolders(), []);
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ MAX_CONCURRENT_TRANSCODES: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "lets a viewer switch streams on a full server, and keeps others out",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);
          const viewer = signTestToken({ fid: fileId, sid: "switching" });

          const status = (token: string, startSeconds: number) =>
            HttpClient.execute(
              HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  token,
                  capabilities: smallScreen,
                  startSeconds,
                }),
              ),
            ).pipe(
              Effect.map((response) => response.status),
              Effect.orDie,
            );

          assert.strictEqual(yield* status(viewer, 0), 200);
          assert.strictEqual(yield* status(viewer, 5), 200);
          assert.strictEqual(yield* status(signTestToken({ fid: fileId, sid: "other" }), 0), 503);
        }),
      30_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: brokenStart, MAX_CONCURRENT_TRANSCODES: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "closes a stream whose encoder fails before writing anything, and frees its slot",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);

          const negotiate = (sid: string) =>
            negotiateRequest(server.baseUrl, signTestToken({ fid: fileId, sid })).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeNegotiation),
              Effect.orDie,
            );

          const negotiated = yield* negotiate("broken");
          const playlist = new URL(local(server.baseUrl, negotiated.url));

          const first = yield* HttpClient.get(
            new URL(`0.m4s${playlist.search}`, playlist).toString(),
          );

          assert.strictEqual(first.status, 500);
          yield* awaitNoStreams("5 seconds");

          const timeline = timelineOf(PlaybackSessionId.make("broken"), server.logged(), false);

          assert.deepStrictEqual(
            Option.map(timeline, (found) =>
              found.entries
                .filter((entry) => entry.kind === "encoder-failed")
                .map((entry) => entry.summary),
            ),
            Option.some(["Encoder failed in transcode-software"]),
          );

          assert.strictEqual((yield* negotiate("next")).mode, "transcode-software");
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer({ FFPROBE_PATH: slowScan, MAX_CONCURRENT_TRANSCODES: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "copies once the scan finishes when no transcode slot is free to encode meanwhile",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = yield* addTransportStream.pipe(Effect.orDie);

          const busy = yield* negotiateRequest(
            server.baseUrl,
            signTestToken({ fid: server.fileId("movies", library.directMovie), sid: "busy" }),
          ).pipe(Effect.orDie);

          assert.strictEqual(busy.status, 200);

          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                token: signTestToken({ fid: fileId, sid: "waits" }),
                capabilities: {
                  containers: ["mp4"],
                  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
                  audioCodecs: [{ codec: "aac" }],
                  maxWidth: 1920,
                  maxHeight: 1080,
                  hls: false,
                  mse: true,
                },
              }),
            ),
          ).pipe(Effect.orDie);

          assert.strictEqual(response.status, 200);

          const negotiated = yield* response.json.pipe(
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "remux");
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: damagedEnd }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "keeps a stream that played when a seek's run fails, so a seek elsewhere still works",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* negotiateRequest(server.baseUrl, token).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          const streamId = negotiated.streamId ?? "";
          const playlist = new URL(local(server.baseUrl, negotiated.url));

          const segment = (generation: number, index: number) =>
            HttpClient.get(
              new URL(
                `/media/hls/${streamId}/${String(generation)}/${String(index)}.m4s${playlist.search}`,
                playlist,
              ).toString(),
            ).pipe(Effect.map((response) => response.status));

          const seek = (positionSeconds: number) =>
            HttpClient.execute(
              HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ token, streamId, positionSeconds }),
              ),
            ).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(Schema.decodeUnknownEffect(SeekResponse)),
              Effect.orDie,
            );

          assert.strictEqual(yield* segment(negotiated.generation ?? 1, 0), 200);

          const broken = yield* seek(8);

          assert.strictEqual(yield* segment(broken.generation, 5), 500);

          const back = yield* seek(0);

          assert.strictEqual(yield* segment(back.generation, 0), 200);
        }),
      60_000,
    );
  });
});
