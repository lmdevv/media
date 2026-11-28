import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Result } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import { hlsCommand } from "./transcode-command.ts";
import {
  candidateKeys,
  type DomainBinding,
  planVideo,
  type VideoIntent,
} from "./video-pipeline.ts";
import { type GpuDomain, Op, sdrTarget, type SourceVideo } from "./video-ops.ts";

const hasQsv = await qsvUsable();

const hasVaapi = await vaapiUsable();

const FIXTURES = join(import.meta.dirname, "..", "testing", "fixtures");

/** A 3840x2160 H.264 picture, as each file carries it. */
const SOURCE: SourceVideo = {
  codec: "h264",
  pixelFormat: "yuv420p",
  depth: 8,
  colour: "sdr",
  scan: "progressive",
  width: 3840,
  height: 2160,
};

/** The PGS tracks the files carry: a white bar on a 1920x1080 canvas, and the same on 1280x720. */
const TRACKS = [
  { canvas: "1080", sup: join(FIXTURES, "pgs-1080.sup") },
  { canvas: "720", sup: join(FIXTURES, "pgs-720.sup") },
] as const;

const DEVICE = process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128";

/** The plan for burning the file's PGS track (stream 1) into the 4K picture on `domain`. */
const planOn = (domain: GpuDomain | "cpu") => {
  const intent: VideoIntent = {
    targets: [sdrTarget("h264")],
    frameRate: undefined,
    bounds: { width: 3840, height: 2160 },
    cpuEncodeBounds: { width: 3840, height: 2160 },
    maxBitrate: undefined,
    burn: Op.BurnImage({
      subtitle: {
        input: 0,
        stream: 1,
        codec: "hdmv_pgs_subtitle",
        frame: {
          memory: "cpu",
          device: undefined,
          colour: "sdr",
          depth: 8,
          pixelFormat: "pal8",
          scan: "progressive",
          width: 1920,
          height: 1080,
        },
      },
    }),
  };

  const domains: ReadonlyArray<DomainBinding> =
    domain === "cpu" ? [] : [{ domain, device: DEVICE }];

  const keys = candidateKeys(SOURCE, intent, { domains, verified: new Set(), excluded: new Set() });

  const planned = planVideo(SOURCE, intent, {
    domains,
    verified: new Set(keys.keys()),
    excluded: new Set(),
  });

  if (Result.isFailure(planned)) throw new Error(JSON.stringify(planned.failure));

  return VideoPlan.Encode({ intent, ...planned.success });
};

/** The box of bright samples in a 3840x2160 gray picture, or nothing when there are none. */
const brightBox = (gray: Uint8Array) => {
  let box: [number, number, number, number] | undefined;

  for (let at = 0; at < gray.length; at += 1) {
    if ((gray[at] ?? 0) > 200) {
      const x = at % 3840;
      const y = Math.floor(at / 3840);

      box =
        box === undefined
          ? [x, y, x, y]
          : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
  }

  return box;
};

describe.runIf(hasQsv || hasVaapi)("PGS burned into a 4K picture on this machine's GPU", () => {
  layer(
    MediaTools.layer.pipe(
      Layer.provide(testConfigLayer({ FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    { excludeTestServices: true, timeout: "300 seconds" },
  )((it) => {
    it.effect(
      "draws a canvas ffmpeg learns only from its first packet where it belongs, on every path",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tools = yield* MediaTools.Service;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-pgs-4k-" });

          const domains = [
            ...(hasQsv ? ["qsv" as const] : []),
            ...(hasVaapi ? ["vaapi" as const] : []),
            "cpu" as const,
          ];

          for (const track of TRACKS) {
            const film = join(root, `film-${track.canvas}.mkv`);

            // Noise keeps the picture at 40 Mbit/s, so ffmpeg's probe reads about a second and the
            // bar, from 6 s to 8 s, is past it: the canvas is unknown when the file opens. The
            // noise never reaches the bar's white.
            yield* tools.ffmpeg([
              "-hide_banner",
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-f",
              "lavfi",
              "-i",
              "color=c=gray:s=3840x2160:r=24:d=9,noise=alls=30:allf=t",
              "-itsoffset",
              "6",
              "-i",
              track.sup,
              "-map",
              "0:v",
              "-map",
              "1:s",
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-b:v",
              "40M",
              "-g",
              "24",
              "-pix_fmt",
              "yuv420p",
              "-c:s",
              "copy",
              film,
            ]);

            for (const domain of domains) {
              const name = `${domain}, ${track.canvas} canvas`;
              const output = join(root, `${domain}-${track.canvas}`);

              yield* fs.makeDirectory(output);

              const run = hlsCommand({
                input: film,
                sourceStart: 0,
                from: 0,
                videoIndex: 0,
                videoCodec: "h264",
                video: planOn(domain),
                audio: AudioPlan.None(),
                audioCodec: "",
                copiedAudioEnd: undefined,
                segmentStarts: [0, 3, 6],
                files: {},
                previousStart: undefined,
                outputDirectory: output,
              });

              const ran = yield* tools
                .ffmpeg(run.args, { timeout: Duration.seconds(120) })
                .pipe(Effect.result);

              assert.isTrue(
                Result.isSuccess(ran),
                `${name}: ${Result.isFailure(ran) ? ran.failure.message : ""}`,
              );

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
                "select=gte(t\\,7),format=gray",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                frame,
              ]);

              // The canvas scaled to the picture's height (2x), its bar's white at 984-2855 and
              // 1824-2015, whichever size the canvas turned out to be.
              const box = brightBox(yield* fs.readFile(frame));

              assert.isDefined(box, `${name}: no bar`);
              const [left, top, right, bottom] = box;

              assert.closeTo(left, 984, 6, `${name}: left`);
              assert.closeTo(top, 1824, 6, `${name}: top`);
              assert.closeTo(right, 2855, 6, `${name}: right`);
              assert.closeTo(bottom, 2015, 6, `${name}: bottom`);
            }
          }
        }).pipe(Effect.scoped),
      300_000,
    );
  });
});
