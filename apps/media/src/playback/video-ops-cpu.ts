/**
 * The CPU's rows: libavcodec's software decoders, `scale`, the `zscale` tone map, the image
 * subtitle overlay, and libx264, libx265, and libsvtav1, a row each. A build listing proves these
 * present, as they touch no device.
 * They are the floor every source falls back to, so they take any layout and depth ffmpeg
 * decodes, as software transcoding always has; closed lists guard the GPU rows instead.
 */
import { type Level, levelOf } from "./output-levels.ts";
import { DECODE_CLIPS, PROBE_CLIPS } from "./probe-clips.ts";
import {
  encodeProbes,
  encodeRowId,
  encodesTarget,
  filter,
  HDR_COLOURS,
  ImplId,
  NOTHING,
  Op,
  type OpImpl,
  OUTPUT_CODECS,
  type OutputCodec,
  row,
  type Row,
  transferOf,
} from "./video-ops.ts";

/** Any codec ffmpeg decodes in software, in the layout the stream has. */
const decodeCpu: OpImpl<"Decode"> = {
  id: ImplId("decode.cpu"),
  op: "Decode",
  on: "cpu",
  takes: "cpu",
  needs: (op) => [`decodes:${op.codec}`],
  variant: (op, input) => `${op.codec}/${input.pixelFormat}`,
  output: (_, input) => ({ ...input, memory: "cpu" }),
  render: () => NOTHING,
  probes: DECODE_CLIPS.map((clip) => ({
    op: Op.Decode({ codec: PROBE_CLIPS[clip].source.codec }),
    clip,
    runs: 1,
  })),
};

/** Bicubic scaling that keeps the frames' layout, whatever it is. */
const scaleCpu: OpImpl<"Scale"> = {
  id: ImplId("scale.cpu"),
  op: "Scale",
  on: "cpu",
  takes: "cpu",
  needs: () => ["filter:scale"],
  variant: (op, input) =>
    op.depth === input.depth ? `${String(input.depth)}>${String(op.depth)}` : undefined,
  output: (op, input) => ({ ...input, width: op.width, height: op.height }),
  render: (op) => ({
    ...NOTHING,
    filters: [filter("scale", String(op.width), String(op.height), ["flags", "bicubic"])],
  }),
  probes: [
    { op: Op.Scale({ width: 160, height: 120, depth: 8 }), clip: "h264-8", runs: 1 },
    { op: Op.Scale({ width: 160, height: 120, depth: 10 }), clip: "hevc-10", runs: 1 },
  ],
};

/**
 * HDR to SDR in software: linearize, map with Hable onto 100 nits, convert to BT.709. Needs
 * ffmpeg's `zscale` (libzimg) and `tonemap`.
 */
const toneMapCpu: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.cpu"),
  op: "ToneMap",
  on: "cpu",
  takes: "cpu",
  needs: () => ["filter:zscale", "filter:tonemap"],
  variant: (_, input) => (HDR_COLOURS.has(input.colour) ? transferOf(input.colour) : undefined),
  output: (_, input) => ({ ...input, colour: "sdr", depth: 8, pixelFormat: "yuv420p" }),
  render: () => ({
    ...NOTHING,
    filters: [
      filter("zscale", ["t", "linear"], ["npl", "100"]),
      filter("format", "gbrpf32le"),
      filter("zscale", ["p", "bt709"]),
      filter("tonemap", ["tonemap", "hable"], ["desat", "0"]),
      filter("zscale", ["t", "bt709"], ["m", "bt709"], ["r", "tv"]),
    ],
  }),
  probes: [
    { op: Op.ToneMap(), clip: "hevc-pq", runs: 1 },
    { op: Op.ToneMap(), clip: "hevc-hlg", runs: 1 },
  ],
};

/**
 * Draws an image subtitle on the SDR picture at its size: the subtitle's canvas (720x576 for DVD)
 * is scaled to the picture it covers. Subtitles are SDR, so this comes after any tone map.
 */
const burnImageCpu: OpImpl<"BurnImage"> = {
  id: ImplId("burn-image.cpu"),
  op: "BurnImage",
  on: "cpu",
  takes: "cpu",
  needs: () => ["filter:overlay", "filter:scale"],
  variant: (op, input) =>
    input.colour === "sdr" && op.subtitle.frame.memory === "cpu" ? "bitmap" : undefined,
  output: (_, input) => ({ ...input, depth: 8, pixelFormat: "yuv420p" }),
  render: (op, input) => ({
    ...NOTHING,
    filters: [filter("overlay", ["eof_action", "pass"], ["repeatlast", "0"])],
    side: {
      input: op.subtitle.input,
      stream: op.subtitle.stream,
      calls: [filter("scale", String(input.width), String(input.height))],
    },
  }),
  probes: [
    {
      op: Op.BurnImage({
        subtitle: {
          input: 1,
          stream: 0,
          codec: "rawvideo",
          frame: {
            memory: "cpu",
            device: undefined,
            colour: "sdr",
            depth: 8,
            pixelFormat: "yuva420p",
            scan: "progressive",
            width: 320,
            height: 240,
          },
        },
      }),
      clip: "h264-8",
      runs: 1,
    },
  ],
};

/**
 * One codec's software encoder: its name, the options that set its speed, profile, and quality
 * target before the bitrate cap, and those after it, which state the plan's level when it has one.
 */
interface SoftwareEncoder {
  readonly name: string;
  readonly quality: ReadonlyArray<string>;
  readonly after: (level: Level | undefined) => ReadonlyArray<string>;
}

/**
 * The 8-bit SDR encoder of each codec, each at a quality target near libx264's CRF 23 and a speed
 * that keeps up with a 1080p stream on a desktop CPU. libx265 closes its GOPs, or a forced
 * keyframe is a CRA picture whose leading pictures need the segment before, and makes each forced
 * keyframe an IDR frame (`forced-idr`): without it, a forced keyframe less than a second after a
 * scene cut's keyframe is dropped. libx265 is the slowest, near 65 frames a second at 1920x818
 * with Debian's build on a Ryzen 9 5950X (its `veryfast`, 43). SVT-AV1's presets above 9 warn of
 * artifacts outside its real-time mode.
 */
const SOFTWARE_ENCODERS: Readonly<Record<OutputCodec, SoftwareEncoder>> = {
  h264: {
    name: "libx264",
    quality: ["-preset", "veryfast", "-profile:v", "high", "-crf", "23"],
    after: () => [],
  },
  hevc: {
    name: "libx265",
    quality: ["-preset", "superfast", "-profile:v", "main", "-crf", "28"],
    after: (level) => [
      "-forced-idr",
      "1",
      "-x265-params",
      [
        "log-level=error",
        "open-gop=0",
        ...(level === undefined ? [] : [`level-idc=${String(level.tenths)}`]),
      ].join(":"),
    ],
  },
  av1: {
    name: "libsvtav1",
    quality: ["-preset", "9", "-crf", "30"],
    // SVT-AV1 holds many frames before its first packets, and the muxer stops waiting for video
    // (`max_interleave_delta`) and writes the copied audio ahead into earlier fragments: after a
    // seek, a fragment opened with up to six seconds of silence. It waits for the video instead.
    after: (level) => [
      "-max_interleave_delta",
      "0",
      ...(level === undefined ? [] : ["-svtav1-params", `level=${String(level.tenths)}`]),
    ],
  },
};

/**
 * The software encoder of `codec`, a row of its own: a quality target under a VBV cap, from any
 * SDR layout and depth, converted to 8-bit 4:2:0. Every forced keyframe is an IDR frame (H.264,
 * HEVC) or a key frame (AV1).
 */
const encodeCpu = (codec: OutputCodec): OpImpl<"Encode"> => {
  const encoder = SOFTWARE_ENCODERS[codec];

  return {
    id: encodeRowId("cpu", codec),
    op: "Encode",
    on: "cpu",
    takes: "cpu",
    needs: () => [`encoder:${encoder.name}`],
    variant: (op, input) =>
      encodesTarget(codec, op.target) && input.colour === "sdr" && input.scan === "progressive"
        ? `${String(op.target.depth)}/crf`
        : undefined,
    output: (_, input) => ({ ...input, depth: 8, pixelFormat: "yuv420p" }),
    render: (op) => ({
      input: [],
      filters: [filter("format", "yuv420p")],
      output: [
        "-c:v",
        encoder.name,
        ...encoder.quality,
        "-maxrate",
        String(op.bitrate),
        "-bufsize",
        String(op.bitrate * 2),
        ...encoder.after(op.level === undefined ? undefined : levelOf(codec, op.level)),
      ],
    }),
    probes: encodeProbes(codec),
  };
};

/** Every CPU row. */
export const CPU_ROWS: ReadonlyArray<Row> = [
  row(decodeCpu),
  row(scaleCpu),
  row(toneMapCpu),
  row(burnImageCpu),
  ...OUTPUT_CODECS.map((codec) => row(encodeCpu(codec))),
];
