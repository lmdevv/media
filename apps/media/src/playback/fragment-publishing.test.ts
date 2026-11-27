import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Ref, Result, Schedule, Stream } from "effect";
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

/** Bytes written to ffmpeg's standard input at a time; Node and the pipe buffer some 80 KB more. */
const CHUNK = 4096;

/**
 * How much more of the source a codec's run may have read than the H.264 run when its first
 * fragment appears. With the muxer's default 10-second wait for a stream without packets, each
 * software encoder's first fragment of this source came out with 44 to 61 % of it read, run to
 * run, with NixOS's ffmpeg 9.0.2, and within 13 points of the H.264 run with Debian's 7.1; with a
 * wait without a bound, only at the end, once the audio came back at 42 s. Nixpkgs' ffmpeg 9.0.1
 * waits for the audio with every encoder.
 */
const MARGIN = 0.25;

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
 * Feeds `source` to ffmpeg running `args` on standard input as fast as ffmpeg takes it, and answers
 * the share of `source` written when the first fragment `first` appeared. ffmpeg reads only as far
 * ahead of its encoder and muxer as its queues hold, so the share is how far into the source the
 * fragment came out, however fast the machine encodes; 1 when it came out only at the end.
 */
const publishedAt = Effect.fn("FragmentPublishing.publishedAt")(function* (
  args: ReadonlyArray<string>,
  source: Uint8Array,
  first: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const written = yield* Ref.make(0);
  const stderr: Array<string> = [];

  // One chunk a pull: the sink pulls the next once ffmpeg's pipe has taken the last.
  const input = Stream.unfold(0, (offset) =>
    offset >= source.length
      ? Effect.undefined
      : Ref.set(written, Math.min(source.length, offset + CHUNK)).pipe(
          Effect.as([source.subarray(offset, offset + CHUNK), offset + CHUNK] as const),
        ),
  );

  const handle = yield* spawner.spawn(
    ChildProcess.make(ffmpegPath, args, { stdin: input, stdout: "ignore", stderr: "pipe" }),
  );

  const output = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.sync(() => stderr.push(text))),
    Effect.forkScoped,
  );

  const appeared = yield* fs
    .exists(first)
    .pipe(
      Effect.repeat({ until: (present) => present, schedule: Schedule.spaced("10 millis") }),
      Effect.andThen(Ref.get(written)),
      Effect.forkScoped,
    );

  const code = yield* handle.exitCode;

  yield* Fiber.join(output);

  if (code !== ChildProcessSpawner.ExitCode(0) || !(yield* fs.exists(first))) {
    return yield* Effect.die(
      `ffmpeg exited ${String(code)} without a fragment: ${stderr.join("")}`,
    );
  }

  return (yield* Fiber.join(appeared)) / source.length;
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
    it.effect(
      "publishes each software encoder's first fragment while its copied audio is silent, no later than the H.264 row does",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const source = path.join(directory, "sparse.mkv");

          yield* writeSource(source);

          const bytes = yield* fs.readFile(source);

          const shares = yield* Effect.forEach(OUTPUT_CODECS, (codec) =>
            Effect.gen(function* () {
              const output = path.join(directory, codec);

              yield* fs.makeDirectory(output);

              const args = yield* encodeArgs(source, codec, output);

              return [codec, yield* publishedAt(args, bytes, path.join(output, "f0.m4s"))] as const;
            }),
          );

          const h264 = shares.find(([codec]) => codec === "h264")?.[1] ?? Number.NaN;

          for (const [codec, share] of shares) {
            assert.isAtMost(
              share,
              h264 + MARGIN,
              `${codec}: first fragment after ${(share * 100).toFixed(0)} % of the source, H.264's after ${(h264 * 100).toFixed(0)} %`,
            );
          }
        }).pipe(Effect.scoped, Effect.orDie),
      120_000,
    );
  });
});
