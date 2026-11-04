import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Path, PlatformError, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import { LibraryId } from "@media/contracts/ids";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { fragmentSpan, videoTiming } from "./fmp4-fragments.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as StreamSessions from "./stream-sessions.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1 });

const qsvFailsAfterFirstFragment = await writeFakeFfmpeg({
  qsvFailsAfterFirstFragmentBefore: 1_000_000,
});

const failsAfterFirstFragment = await writeFakeFfmpeg({ hlsFailsAfterFirstFragment: true });

const stallsAfterTwoFragments = await writeFakeFfmpeg({ hlsStallsAfterFragments: 2 });

const unreadable = { firstFragmentOpens: 0 };

const flakyFirstFragment = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    open: (path, options) =>
      path.endsWith("/1/f0.m4s") && unreadable.firstFragmentOpens > 0
        ? Effect.suspend(() => {
            unreadable.firstFragmentOpens -= 1;

            return Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "open",
                description: "the disk is busy",
              }),
            );
          })
        : real.open(path, options),
  });

const HALF_SECOND_GOPS = "Half Second Gops (2020)/Half Second Gops (2020).mkv";

const startsLateThenStalls = await writeFakeFfmpeg({
  hlsDelayMs: 1500,
  hlsStallsAfterFragments: 1,
});

const LATE_KEYFRAME = 383 / 24;

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const remuxScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

describe.skipIf(!hasFfmpeg)("stream startup", () => {
  layer(MediaTestServer.layer({ FFMPEG_PATH: stallsAfterFirstFragment }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "serves the init and first segments once the first fragment is written, before the encoder writes the next",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "transcode-software");
          const url = new URL(negotiated.url);

          const file = (name: string) =>
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, name)}${url.search}`;

          const [init, first] = yield* Effect.all(
            [HttpClient.get(file("init.mp4")), HttpClient.get(file("0.m4s"))],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("10 seconds"), Effect.orDie);

          assert.strictEqual(init.status, 200, "init segment");
          assert.strictEqual(first.status, 200, "first segment");
          assert.isAbove((yield* first.arrayBuffer.pipe(Effect.orDie)).byteLength, 0);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer({
      FFMPEG_PATH: qsvFailsAfterFirstFragment,
      HARDWARE_ACCELERATION: "qsv",
    }),
    { excludeTestServices: true, timeout: "60 seconds" },
  )((it) => {
    it.effect(
      "falls back to software before serving when Quick Sync fails after its first fragment",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "transcode-software");

          const changes = (yield* recording.events).filter(
            PlaybackReporter.PlaybackEvent.guards.ModeChanged,
          );

          assert.deepStrictEqual(
            changes.map((change) => [change.from, change.to, change.reason]),
            [["transcode-qsv", "transcode-software", "hardware-unavailable"]],
          );
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: startsLateThenStalls }).pipe(
      Layer.provide(Layer.succeed(StreamSessions.PollInterval, Duration.minutes(5))),
    ),
    { excludeTestServices: true, timeout: "60 seconds" },
  )((it) => {
    it.effect(
      "answers a waiting segment request when its fragment is written, not on the next poll",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          const url = new URL(negotiated.url);

          const first = yield* HttpClient.get(
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, "0.m4s")}${url.search}`,
          ).pipe(Effect.timeout("20 seconds"), Effect.orDie);

          assert.strictEqual(first.status, 200, "first segment");
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect(
      "starts each copied fragment where the previous one ends, even when the last frame's duration overshoots",
      () =>
        Effect.gen(function* () {
          const workspace = yield* FixtureWorkspace.Service;
          const tools = yield* MediaTools.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(workspace.root, "vfr");
          const output = path.join(root, "hls");
          const steady = path.join(root, "steady.mkv");
          const variable = path.join(root, "variable.mkv");

          yield* fs.makeDirectory(output, { recursive: true });
          yield* tools.ffmpeg([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=24",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-bf",
            "0",
            "-g",
            "1000",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-force_key_frames",
            `0,4,8,12,${String(LATE_KEYFRAME)},16,20`,
            steady,
          ]);
          // The frame before the keyframe at 383/24 s moves to 3 ms before it, so it keeps its
          // 41 ms duration and the fragment it ends seems to run 38 ms past that keyframe.
          yield* tools.ffmpeg([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            steady,
            "-c",
            "copy",
            "-bsf:v",
            `setts=ts='if(eq(N\\,382)\\,round(${String(LATE_KEYFRAME - 0.003)}/TB)\\,TS)'`,
            variable,
          ]);
          yield* tools.ffmpeg(
            hlsCommandArgs({
              input: variable,
              sourceStart: 0,
              from: 0,
              videoIndex: 0,
              videoCodec: "h264",
              videoBitDepth: 8,
              video: VideoPlan.Copy(),
              audio: AudioPlan.None(),
              audioCodec: "",
              copiedAudioEnd: undefined,
              subtitleCodec: "",
              segmentStarts: [0, 4, 8, 12, 16, 20],
              previousStart: undefined,
              outputDirectory: output,
              qsvDevice: "",
              vaapiDevice: "",
            }),
          );

          const names = (yield* fs.readDirectory(output))
            .flatMap((name) => /^f(\d+)\.m4s$/u.exec(name)?.[1] ?? [])
            .map(Number)
            .toSorted((left, right) => left - right);

          const timing = videoTiming(yield* fs.readFile(path.join(output, "init.mp4")));

          assert.isDefined(timing, "the run's init segment has no video");

          const spans = yield* Effect.forEach(names, (number) =>
            fs
              .readFile(path.join(output, `f${String(number)}.m4s`))
              .pipe(Effect.map((bytes) => fragmentSpan(timing, bytes))),
          );

          assert.isTrue(
            spans.some(
              (span) =>
                span !== undefined && span.start < 12.1 && (span.end ?? 0) > LATE_KEYFRAME + 0.03,
            ),
            "the fragment before the late keyframe claims to run past it",
          );

          // A fragment whose first frame is presented a tick before it is decoded starts that tick
          // before the previous one's samples end.
          for (const [index, span] of spans.entries()) {
            if (index === 0) continue;

            const ticks =
              ((span?.start ?? Number.NaN) - (spans[index - 1]?.end ?? Number.NaN)) *
              timing.timescale;

            assert.isAtMost(
              Math.abs(Math.round(ticks)),
              1,
              `f${String(index)} starts where f${String(index - 1)} ends`,
            );
          }
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: failsAfterFirstFragment }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "serves a whole segment from a software run that failed right after writing it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          const first = path.join(server.transcodeDir, negotiated.streamId ?? "", "1", "f0.m4s");

          yield* fs.exists(first).pipe(
            Effect.filterOrFail((exists) => exists),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout("20 seconds"),
            Effect.orDie,
          );
          yield* Effect.sleep("1 second");

          const url = new URL(negotiated.url);

          const segment = yield* HttpClient.get(
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, "0.m4s")}${url.search}`,
          ).pipe(Effect.orDie);

          assert.strictEqual(segment.status, 200, "the segment the run finished");
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: stallsAfterTwoFragments },
      { fileSystem: flakyFirstFragment },
    ),
    { excludeTestServices: true, timeout: "60 seconds" },
  )((it) => {
    it.effect(
      "waits for a fragment that failed to read before serving the segment it belongs to",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const workspace = yield* FixtureWorkspace.Service;
          const tools = yield* MediaTools.Service;
          const scanner = yield* LibraryScanner.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const library = LibraryId.make("half-second-gops");
          const root = path.join(workspace.root, "half-second-gops");
          const source = path.join(root, HALF_SECOND_GOPS);

          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* tools.ffmpeg([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=6",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "12",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-an",
            source,
          ]);
          yield* scanner.scan({ libraryId: library, root, mode: "incremental" });

          const token = signTestToken({ fid: MemoryLibrary.fileIdOf(library, HALF_SECOND_GOPS) });

          const negotiated = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: remuxScreen }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "remux");
          unreadable.firstFragmentOpens = 2;

          const url = new URL(negotiated.url);

          const segment = yield* HttpClient.get(
            `${server.baseUrl}${url.pathname.replace(/index\.m3u8$/u, "0.m4s")}${url.search}`,
          ).pipe(
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.timeout("20 seconds"),
            Effect.orDie,
          );

          const run = path.join(server.transcodeDir, negotiated.streamId ?? "", "1");

          const whole = yield* Effect.forEach(["f0.m4s", "f1.m4s"], (name) =>
            fs.stat(path.join(run, name)).pipe(Effect.map((info) => Number(info.size))),
          ).pipe(Effect.orDie);

          assert.strictEqual(
            segment.byteLength,
            whole.reduce((total, size) => total + size, 0),
            "segment 0 holds both of its fragments",
          );
          assert.strictEqual(unreadable.firstFragmentOpens, 0, "the first fragment failed to read");
        }),
      60_000,
    );
  });
});
