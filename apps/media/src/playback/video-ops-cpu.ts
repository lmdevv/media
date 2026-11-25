/**
 * The CPU's rows: libavcodec's software decoders, `scale`, the `zscale` tone map, the image
 * subtitle overlay, and libx264. A build listing proves these present, as they touch no device.
 */
import { DECODE_CLIPS, PROBE_CLIPS } from "./probe-clips.ts";
import {
  DEPTHS,
  filter,
  HDR_COLOURS,
  ImplId,
  NOTHING,
  Op,
  type OpImpl,
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

/** Bicubic scaling that keeps the frames' layout. */
const scaleCpu: OpImpl<"Scale"> = {
  id: ImplId("scale.cpu"),
  op: "Scale",
  on: "cpu",
  takes: "cpu",
  needs: () => ["filter:scale"],
  variant: (op, input) =>
    DEPTHS.has(input.depth) && op.depth === input.depth
      ? `${String(input.depth)}>${String(op.depth)}`
      : undefined,
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

/** libx264 at CRF 23 under a VBV cap, from any CPU layout it converts to 8-bit 4:2:0. */
const encodeCpu: OpImpl<"Encode"> = {
  id: ImplId("encode.cpu"),
  op: "Encode",
  on: "cpu",
  takes: "cpu",
  needs: () => ["encoder:libx264"],
  variant: (op, input) =>
    input.colour === "sdr" && input.scan === "progressive" && DEPTHS.has(input.depth)
      ? `${op.codec}/8/crf`
      : undefined,
  output: (_, input) => ({ ...input, depth: 8, pixelFormat: "yuv420p" }),
  render: (op) => ({
    input: [],
    filters: [filter("format", "yuv420p")],
    output: [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      "high",
      "-crf",
      "23",
      "-maxrate",
      String(op.bitrate),
      "-bufsize",
      String(op.bitrate * 2),
    ],
  }),
  probes: [{ op: Op.Encode({ codec: "h264", bitrate: 1_000_000 }), clip: "h264-8", runs: 1 }],
};

/** Every CPU row. */
export const CPU_ROWS: ReadonlyArray<Row> = [
  row(decodeCpu),
  row(scaleCpu),
  row(toneMapCpu),
  row(burnImageCpu),
  row(encodeCpu),
];
