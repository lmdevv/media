import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import { verifiedFor } from "../testing/capability-snapshots.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { AudioPlan, replan } from "./playback-decision.ts";
import { hlsCommand } from "./transcode-command.ts";
import { OUTPUT_CODECS, type OutputCodec, sdrTarget } from "./video-ops.ts";

const hasFfmpeg = await ffmpegAvailable();

const ffmpegPath = process.env["FFMPEG_PATH"] ?? "ffmpeg";

const SECONDS = 48;

/**
 * The share of the source fed before its first fragment must be out. With the muxer's default
 * 10-second wait for a stream without packets, a software encode of this source published it after
 * 34 to 38 % (with Debian's ffmpeg 7.1 and with 9.0); a wait without a bound, after 86 %, once the
 * audio came back at 42 s.
 */
const FED = 0.6;

/** Tenths of a second the run may take to publish once fed: far more than it needs. */
const PUBLISH_WITHIN = 200;

/**
 * Forty-eight seconds of 192x128 MPEG-2 whose AAC plays for the first two seconds and the last
 * six, with no packet between, as a track with a long silence left out.
 */
const writeSource = Effect.fn("FragmentPublishing.writeSource")(function* (file: string) {
  const tools = yield* MediaTools.Service;

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=192x128:r=24:duration=${String(SECONDS)}`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=8",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "mpeg2video",
    "-g",
    "96",
    "-c:a",
    "aac",
    "-bsf:a",
    String.raw`setts=ts=if(gte(TS\,2/TB)\,TS+40/TB\,TS)`,
    file,
  ]);
});

/**
 * The service's arguments for a software encode of `file` to `codec` that copies its audio and
 * reads the file from standard input.
 */
const encodeArgs = Effect.fn("FragmentPublishing.encodeArgs")(function* (
  file: string,
  codec: OutputCodec,
  outputDirectory: string,
) {
  const probe = yield* probeFile(file);
  const video = probe.video;
  const audio = probe.audio[0];

  if (video === undefined || audio === undefined) return yield* Effect.die("the source has both");

  const planned = replan(
    video,
    {
      targets: [sdrTarget(codec)],
      frameRate: video.frameRate,
      bounds: { width: video.width, height: video.height },
      cpuEncodeBounds: { width: 1920, height: 1080 },
      maxBitrate: 1_000_000,
      burnImage: undefined,
    },
    verifiedFor(probe),
  );

  if (Result.isFailure(planned)) return yield* Effect.die(planned.failure);

  return hlsCommand({
    input: "pipe:0",
    sourceStart: 0,
    from: 0,
    videoIndex: video.index,
    videoCodec: video.codec,
    video: planned.success,
    audio: AudioPlan.Copy({ index: audio.index }),
    audioCodec: audio.codec,
    copiedAudioEnd: undefined,
    segmentStarts: Array.from({ length: SECONDS / 4 }, (_, index) => index * 4),
    previousStart: undefined,
    outputDirectory,
  }).args;
});

/**
 * Runs ffmpeg with `args`, feeds it the first `share` of `source` on standard input, and answers
 * whether its first fragment `first` is out within `PUBLISH_WITHIN` tenths of a second, with what
 * it wrote to stderr. The rest of `source` follows only then, so the run ends as it would.
 */
const publishesOnceFed = Effect.fn("FragmentPublishing.publishesOnceFed")(function* (
  args: ReadonlyArray<string>,
  source: Uint8Array,
  share: number,
  first: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const checked = yield* Deferred.make<void>();
  const stderr: Array<string> = [];
  const fed = Math.floor(source.length * share);

  const input = Stream.make(source.subarray(0, fed)).pipe(
    Stream.concat(Stream.fromEffect(Deferred.await(checked).pipe(Effect.as(source.subarray(fed))))),
  );

  const handle = yield* spawner.spawn(
    ChildProcess.make(ffmpegPath, args, { stdin: input, stdout: "ignore", stderr: "pipe" }),
  );

  const output = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.sync(() => stderr.push(text))),
    Effect.forkScoped,
  );

  const published = yield* fs.exists(first).pipe(
    Effect.repeat({
      until: (present) => present,
      schedule: Schedule.spaced("100 millis"),
      times: PUBLISH_WITHIN,
    }),
  );

  yield* Deferred.succeed(checked, undefined);
  yield* handle.exitCode;
  yield* Fiber.join(output);

  return { published, stderr: stderr.join("") };
}, Effect.scoped);

const tools = MediaTools.layer.pipe(
  Layer.provide(
    testConfigLayer({
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe.runIf(hasFfmpeg)("fragment publishing", () => {
  layer(tools, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    for (const codec of OUTPUT_CODECS) {
      it.effect(
        `publishes a software ${codec} stream's first fragment while its copied audio is silent`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped();
            const source = path.join(directory, "sparse.mkv");
            const output = path.join(directory, "hls");

            yield* writeSource(source);
            yield* fs.makeDirectory(output);

            const args = yield* encodeArgs(source, codec, output);
            const bytes = yield* fs.readFile(source);

            const { published, stderr } = yield* publishesOnceFed(
              args,
              bytes,
              FED,
              path.join(output, "f0.m4s"),
            );

            assert.isTrue(
              published,
              `no fragment once ${String(FED * 100)} % of the source was fed: ${stderr}`,
            );
          }).pipe(Effect.scoped, Effect.orDie),
        60_000,
      );
    }
  });
});
