import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { qsvUsable } from "../testing/fixture-library.ts";
import { withHdr10Plus } from "../testing/hdr10-plus.ts";
import { testConfigLayer } from "../testing/test-config.ts";

const hasQsv = await qsvUsable();

const NODE = process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128";

const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"];

/** The run's devices as Quick Sync's chains open them, with libplacebo's Vulkan derived from them. */
const DEVICES = [
  "-init_hw_device",
  `vaapi=va:${NODE}`,
  "-init_hw_device",
  "qsv=hw@va",
  "-init_hw_device",
  "vulkan=vk@hw",
  "-filter_hw_device",
  "vk",
  "-hwaccel",
  "vaapi",
  "-hwaccel_output_format",
  "vaapi",
  "-hwaccel_device",
  "va",
];

/** The filters that remove HDR10+ and HDR Vivid, as the rows write them (`STRIP_DYNAMIC_HDR_METADATA`). */
const STRIP =
  "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DYNAMIC_HDR_VIVID";

/** Quick Sync's fused scale and tone map, as `tonemap.qsv` renders it, then downloaded. */
const QUICK_SYNC =
  "hwmap=derive_device=qsv,format=qsv,vpp_qsv=w=640:h=360:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709,hwdownload,format=nv12";

/** libplacebo's BT.2390, as its row renders it, which reads HDR10+ when frames carry it. */
const PLACEBO =
  "hwmap=derive_device=qsv,format=qsv,vpp_qsv=w=640:h=360:format=p010,hwdownload,format=p010le,libplacebo=format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:contrast_recovery=0";

/** The frame hashes of a `framemd5` listing, in order. */
const hashes = (text: string): ReadonlyArray<string | undefined> =>
  text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim());

const tools = MediaTools.layer.pipe(
  Layer.provide(
    testConfigLayer({
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe.runIf(hasQsv)("HDR10+ on Quick Sync's own tone map", () => {
  layer(tools, { excludeTestServices: true })((it) => {
    it.effect(
      "maps the same frames with and without the dynamic metadata, which libplacebo reads",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const run = yield* MediaTools.Service;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-hdr10-plus-" });
          const plain = path.join(root, "plain.hevc");
          const clip = path.join(root, "hdr10-plus.mp4");

          // Two seconds of 1080p PQ with HDR10's static metadata, then HDR10+ in every picture.
          yield* run.ffmpeg([
            ...QUIET,
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=24:duration=2",
            "-vf",
            "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-x265-params",
            "log-level=error:hdr10=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
            "-color_primaries",
            "bt2020",
            "-color_trc",
            "smpte2084",
            "-colorspace",
            "bt2020nc",
            "-f",
            "hevc",
            plain,
          ]);
          yield* fs.writeFile(`${plain}.plus`, withHdr10Plus(yield* fs.readFile(plain)));
          yield* run.ffmpeg([
            ...QUIET,
            "-framerate",
            "24",
            "-f",
            "hevc",
            "-i",
            `${plain}.plus`,
            "-c",
            "copy",
            clip,
          ]);

          const carried = yield* run.ffprobe([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-read_intervals",
            "%+#8",
            "-show_entries",
            "frame_side_data=side_data_type",
            "-of",
            "csv",
            clip,
          ]);

          assert.include(carried, "HDR10+", "the clip carries HDR10+");

          const frames = (graph: string) =>
            run.ffmpeg([
              ...QUIET,
              ...DEVICES,
              "-i",
              clip,
              "-vf",
              graph,
              "-an",
              "-f",
              "framemd5",
              "-",
            ]);

          const kept = hashes(yield* frames(QUICK_SYNC));
          const stripped = hashes(yield* frames(`${STRIP},${QUICK_SYNC}`));

          assert.isAtLeast(kept.length, 40, "frames came out");
          assert.deepStrictEqual(kept, stripped, "Quick Sync's tone map reads no HDR10+");

          // The control: libplacebo applies HDR10+, so its frames differ without it.
          const placebo = hashes(yield* frames(PLACEBO));
          const placeboStatic = hashes(yield* frames(`${STRIP},${PLACEBO}`));

          assert.notDeepEqual(placebo, placeboStatic, "libplacebo reads the clip's HDR10+");
        }),
      180_000,
    );
  });
});
