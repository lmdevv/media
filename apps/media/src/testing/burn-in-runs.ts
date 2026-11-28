/**
 * Image subtitles burned in through the service's own planner and HLS command on a real ffmpeg,
 * for tests that check where a subtitle lands on each path and that every path draws it.
 */
import { join } from "node:path";

import { Duration, Effect, FileSystem, Result } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { AudioPlan, VideoPlan } from "../playback/playback-decision.ts";
import { hlsCommand } from "../playback/transcode-command.ts";
import { candidateKeys, type DomainBinding, planVideo } from "../playback/video-pipeline.ts";
import { type GpuDomain, Op, SDR_BT709, sdrTarget, type Size } from "../playback/video-ops.ts";

/** The render node a GPU path runs on. */
const DEVICE = process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128";

/**
 * The plan for burning stream `stream` of `codec` into an 8-bit H.264 picture of `size` on
 * `domain`, encoded at its size, with every row the plan names taken as verified.
 */
export const burnPlan = (
  size: Size,
  codec: string,
  stream: number,
  domain: GpuDomain | "cpu",
): Extract<VideoPlan, { readonly _tag: "Encode" }> => {
  const source = {
    codec: "h264",
    pixelFormat: "yuv420p",
    depth: 8,
    colour: SDR_BT709,
    scan: "progressive",
    ...size,
  } as const;

  const intent = {
    targets: [sdrTarget("h264")],
    frameRate: undefined,
    bounds: size,
    cpuEncodeBounds: size,
    maxBitrate: undefined,
    burn: Op.BurnImage({
      subtitle: {
        input: 0,
        stream,
        codec,
        frame: {
          memory: "cpu",
          device: undefined,
          colour: SDR_BT709,
          depth: 8,
          pixelFormat: "pal8",
          scan: "progressive",
          ...size,
        },
      },
    }),
  };

  const domains: ReadonlyArray<DomainBinding> =
    domain === "cpu" ? [] : [{ domain, device: DEVICE }];

  const keys = candidateKeys(source, intent, { domains, verified: new Set(), excluded: new Set() });

  const planned = planVideo(source, intent, {
    domains,
    verified: new Set(keys.keys()),
    excluded: new Set(),
  });

  if (Result.isFailure(planned)) throw new Error(JSON.stringify(planned.failure));

  return VideoPlan.Encode({ intent, ...planned.success });
};

/**
 * Runs `plan` over `film` into an HLS stream under `output`, from the start, and returns the
 * picture it shows at `time` seconds of the file's clock as gray samples.
 */
export const burnedFrame = Effect.fn(function* (
  film: string,
  plan: Extract<VideoPlan, { readonly _tag: "Encode" }>,
  output: string,
  time: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;

  yield* fs.makeDirectory(output, { recursive: true });

  const run = hlsCommand({
    input: film,
    sourceStart: 0,
    from: 0,
    videoIndex: 0,
    videoCodec: "h264",
    video: plan,
    audio: AudioPlan.None(),
    audioCodec: "",
    copiedAudioEnd: undefined,
    segmentStarts: [0],
    files: {},
    previousStart: undefined,
    outputDirectory: output,
  });

  yield* tools.ffmpeg(run.args, { timeout: Duration.seconds(120) });

  const frame = join(output, "frame.gray");

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    join(output, "ffmpeg.m3u8"),
    "-vf",
    `select=gte(t\\,${String(time)}),format=gray`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    frame,
  ]);

  return yield* fs.readFile(frame);
});

/** The box of samples brighter than a gray picture `width` wide shows elsewhere, or none. */
export const brightBox = (
  gray: Uint8Array,
  width: number,
): readonly [number, number, number, number] | undefined => {
  let box: [number, number, number, number] | undefined;

  for (let at = 0; at < gray.length; at += 1) {
    if ((gray[at] ?? 0) > 200) {
      const x = at % width;
      const y = Math.floor(at / width);

      box =
        box === undefined
          ? [x, y, x, y]
          : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
  }

  return box;
};
