/**
 * The rows of Intel's two GPU APIs, written for any Intel GPU and for AMD's VA-API: Quick Sync
 * (`qsv`, oneVPL derived from a VA-API device) and VA-API (`vaapi`). Each decodes, scales,
 * tone-maps, and encodes H.264, HEVC, and AV1 on the device, and moves frames to and from CPU
 * memory in NV12 or P010. Which of these a device does is evidence, never assumed: a row only says what it may try.
 */
import { DECODE_CLIPS, PROBE_CLIPS } from "./probe-clips.ts";
import {
  type BuildFeature,
  type Domain,
  type DomainSpec,
  filter,
  fusing,
  type GpuDomain,
  HDR_COLOURS,
  ImplId,
  NOTHING,
  Op,
  type OpImpl,
  OUTPUT_CODECS,
  type OutputCodec,
  type OutputTarget,
  type ProbeCase,
  type Rendering,
  row,
  type Row,
  sdrTarget,
  surfaceDepth,
  surfaceFormat,
  transferOf,
} from "./video-ops.ts";

/** Codecs Intel media engines may decode; each codec and layout is still proven per device. */
const DECODED_CODECS: ReadonlySet<string> = new Set(["h264", "hevc", "av1", "vp9", "mpeg2video"]);

/** Layouts a GPU decoder may produce surfaces from. */
const DECODED_FORMATS: ReadonlySet<string> = new Set(["yuv420p", "yuvj420p", "yuv420p10le"]);

/** Depths GPU surfaces hold. */
const SURFACE_DEPTHS: ReadonlySet<number> = new Set([8, 10]);

/**
 * Quick Sync on `QSV_DEVICE`, derived from a VA-API device (`va`) on that render node. With oneVPL
 * builds `qsv=hw:<path>` ignores the path and opens the default GPU; the VA-API device names the
 * node, so a missing one fails, as it should, and Quick Sync's decoder reads through it.
 */
export const QSV: DomainSpec = {
  device: (config) => config.qsvDevice,
  deviceArgs: (device) => [
    "-init_hw_device",
    `vaapi=va:${device}`,
    "-init_hw_device",
    "qsv=hw@va",
    "-filter_hw_device",
    "hw",
  ],
  needs: ["hwaccel:qsv", "hwaccel:vaapi"],
};

/** VA-API on `VAAPI_DEVICE`. */
export const VAAPI: DomainSpec = {
  device: (config) => config.vaapiDevice,
  deviceArgs: (device) => ["-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va"],
  needs: ["hwaccel:vaapi"],
};

const decodeProbes: ReadonlyArray<ProbeCase<"Decode">> = DECODE_CLIPS.map((clip) => ({
  op: Op.Decode({ codec: PROBE_CLIPS[clip].source.codec }),
  clip,
  runs: 3,
}));

const scaleProbes: ReadonlyArray<ProbeCase<"Scale">> = [
  { op: Op.Scale({ width: 160, height: 120, depth: 8 }), clip: "h264-8", runs: 1 },
  { op: Op.Scale({ width: 160, height: 120, depth: 8 }), clip: "hevc-10", runs: 1 },
  { op: Op.Scale({ width: 160, height: 120, depth: 10 }), clip: "hevc-10", runs: 1 },
];

const toneMapProbes: ReadonlyArray<ProbeCase<"ToneMap">> = [
  { op: Op.ToneMap(), clip: "hevc-pq", runs: 1 },
  { op: Op.ToneMap(), clip: "hevc-hlg", runs: 1 },
];

const encodeProbes: ReadonlyArray<ProbeCase<"Encode">> = OUTPUT_CODECS.map((codec) => ({
  op: Op.Encode({ target: sdrTarget(codec), bitrate: 1_000_000 }),
  clip: "h264-8",
  runs: 1,
}));

const moveProbes = (to: Domain): ReadonlyArray<ProbeCase<"Move">> => [
  { op: Op.Move({ to }), clip: "h264-8", runs: 1 },
  { op: Op.Move({ to }), clip: "hevc-10", runs: 1 },
];

const decodeVariant = (op: { readonly codec: string }, pixelFormat: string) =>
  DECODED_CODECS.has(op.codec) && DECODED_FORMATS.has(pixelFormat)
    ? `${op.codec}/${pixelFormat}`
    : undefined;

const scaleVariant = (op: { readonly depth: number }, depth: number) =>
  SURFACE_DEPTHS.has(depth) && SURFACE_DEPTHS.has(op.depth) && op.depth <= depth
    ? `${String(depth)}>${String(op.depth)}`
    : undefined;

const surfaceName = (depth: number): string => (depth > 8 ? "p010" : "nv12");

/** A GPU decoder with `rendering`: surfaces in NV12, or P010 above 8 bits. */
const decodeOn = (
  domain: GpuDomain,
  rendering: Pick<Rendering, "input" | "filters">,
  needs: (codec: string) => ReadonlyArray<BuildFeature>,
): OpImpl<"Decode"> => ({
  id: ImplId(`decode.${domain}`),
  op: "Decode",
  on: domain,
  takes: "cpu",
  needs: (op) => needs(op.codec),
  variant: (op, frame) => decodeVariant(op, frame.pixelFormat),
  output: (_, frame) => {
    const format = surfaceFormat(frame.depth);

    return { ...frame, memory: domain, pixelFormat: format, depth: surfaceDepth(format) };
  },
  render: () => ({ ...NOTHING, ...rendering }),
  probes: decodeProbes,
});

/**
 * Uploads CPU frames to `domain` as NV12, or P010 above 8 bits, with `options` for `hwupload`;
 * `surface`, when given, pins the uploaded frames' format for whatever comes next.
 */
const uploadTo = (
  domain: GpuDomain,
  options: ReadonlyArray<readonly [string, string]>,
  surface: string | undefined,
): OpImpl<"Move"> => ({
  id: ImplId(`move.cpu>${domain}`),
  op: "Move",
  on: domain,
  takes: "cpu",
  needs: () => ["filter:hwupload"],
  variant: (op, frame) => (op.to === domain ? surfaceFormat(frame.depth) : undefined),
  output: (_, frame) => {
    const format = surfaceFormat(frame.depth);

    return { ...frame, memory: domain, pixelFormat: format, depth: surfaceDepth(format) };
  },
  render: (_, frame) => ({
    ...NOTHING,
    filters: [
      filter("format", surfaceFormat(frame.depth)),
      filter("hwupload", ...options),
      ...(surface === undefined ? [] : [filter("format", surface)]),
    ],
  }),
  probes: moveProbes(domain),
});

/** Downloads `domain` surfaces to CPU memory in their own layout. */
const downloadFrom = (domain: GpuDomain): OpImpl<"Move"> => ({
  id: ImplId(`move.${domain}>cpu`),
  op: "Move",
  on: domain,
  takes: domain,
  needs: () => ["filter:hwdownload"],
  variant: (op, frame) =>
    op.to === "cpu" && (frame.pixelFormat === "nv12" || frame.pixelFormat === "p010le")
      ? frame.pixelFormat
      : undefined,
  output: (_, frame) => ({ ...frame, memory: "cpu" }),
  render: (_, frame) => ({
    ...NOTHING,
    filters: [filter("hwdownload"), filter("format", frame.pixelFormat)],
  }),
  probes: moveProbes("cpu"),
});

/** VA-API's hardware decoding on the device Quick Sync is derived from. */
const VAAPI_DECODING: ReadonlyArray<string> = [
  "-hwaccel",
  "vaapi",
  "-hwaccel_output_format",
  "vaapi",
  "-hwaccel_device",
  "va",
];

/**
 * Quick Sync's decoder: VA-API's on the same device, its surfaces mapped with no copy into the
 * Quick Sync device the run already opened as its filter device (`hw`), so no second Quick Sync
 * session opens. oneVPL's own decoders are not used: on an Arc A380 with a 256 MiB BAR, a oneVPL
 * decoder in the same run as `h264_qsv` had the kernel refuse the encoder's page faults (SIGBUS) in
 * 18 of 2,300 all-GPU HEVC runs and 46 of 1,400 HEVC burn-ins; decoding this way crashed in none of
 * 1,800 and in 1 of 900.
 */
const decodeQsv = decodeOn(
  "qsv",
  { input: VAAPI_DECODING, filters: [filter("hwmap"), filter("format", "qsv")] },
  (codec) => ["hwaccel:vaapi", `decodes:${codec}`, "filter:hwmap"],
);

/** `vpp_qsv` scaling; it fuses with a following tone map into one `vpp_qsv`. */
const scaleQsv: OpImpl<"Scale"> = {
  id: ImplId("scale.qsv"),
  op: "Scale",
  on: "qsv",
  takes: "qsv",
  needs: () => ["filter:vpp_qsv"],
  variant: (op, frame) => scaleVariant(op, frame.depth),
  output: (op, frame) => ({
    ...frame,
    width: op.width,
    height: op.height,
    depth: op.depth,
    pixelFormat: surfaceFormat(op.depth),
  }),
  render: (op) => ({
    ...NOTHING,
    filters: [
      fusing(
        "vpp_qsv",
        ["w", String(op.width)],
        ["h", String(op.height)],
        ["format", surfaceName(op.depth)],
      ),
    ],
  }),
  probes: scaleProbes,
};

/** `vpp_qsv`'s tone map from P010 HDR surfaces to BT.709 SDR in NV12. */
const toneMapQsv: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.qsv"),
  op: "ToneMap",
  on: "qsv",
  takes: "qsv",
  needs: () => ["filter:vpp_qsv"],
  variant: (_, frame) =>
    HDR_COLOURS.has(frame.colour) && frame.pixelFormat === "p010le"
      ? transferOf(frame.colour)
      : undefined,
  output: (_, frame) => ({ ...frame, colour: "sdr", depth: 8, pixelFormat: "nv12" }),
  render: () => ({
    ...NOTHING,
    filters: [
      fusing(
        "vpp_qsv",
        ["format", "nv12"],
        ["tonemap", "1"],
        ["out_color_matrix", "bt709"],
        ["out_color_primaries", "bt709"],
        ["out_color_transfer", "bt709"],
      ),
    ],
  }),
  probes: toneMapProbes,
};

/** Whether the GPU encoders take `target`: 8-bit SDR alone. */
const gpuTakes = (target: OutputTarget): boolean => target.depth === 8 && target.colour === "sdr";

/** One codec's GPU encoder: its name and the options before and after the bitrate. */
interface GpuEncoder {
  readonly name: string;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
}

/**
 * A GPU encoder at a fixed bitrate from 8-bit SDR NV12 surfaces, an encoder entry per codec. On
 * the Arc A380 every one of them, with ffmpeg 9 and Debian's 7.1, put an IDR frame (H.264, HEVC)
 * or a key frame (AV1) exactly at each forced keyframe.
 */
const encodeOn = (
  domain: GpuDomain,
  encoders: Readonly<Record<OutputCodec, GpuEncoder>>,
): OpImpl<"Encode"> => ({
  id: ImplId(`encode.${domain}`),
  op: "Encode",
  on: domain,
  takes: domain,
  needs: (op) => [`encoder:${encoders[op.target.codec].name}`],
  variant: (op, frame) =>
    gpuTakes(op.target) &&
    frame.colour === "sdr" &&
    frame.scan === "progressive" &&
    frame.pixelFormat === "nv12"
      ? `${op.target.codec}/${String(op.target.depth)}/cbr`
      : undefined,
  output: (_, frame) => frame,
  render: (op) => {
    const encoder = encoders[op.target.codec];

    return {
      ...NOTHING,
      output: [
        "-c:v",
        encoder.name,
        ...encoder.before,
        "-b:v",
        String(op.bitrate),
        "-maxrate",
        String(op.bitrate),
        "-bufsize",
        String(op.bitrate * 2),
        ...encoder.after,
      ],
    };
  },
  probes: encodeProbes,
});

/** Quick Sync's encoders; `forced_idr` makes each forced keyframe an IDR frame. */
const encodeQsv = encodeOn("qsv", {
  h264: { name: "h264_qsv", before: ["-preset", "veryfast"], after: ["-forced_idr", "1"] },
  hevc: {
    name: "hevc_qsv",
    before: ["-preset", "veryfast", "-profile:v", "main"],
    after: ["-forced_idr", "1"],
  },
  av1: {
    name: "av1_qsv",
    before: ["-preset", "veryfast", "-profile:v", "main"],
    after: ["-forced_idr", "1"],
  },
});

const decodeVaapi = decodeOn("vaapi", { input: VAAPI_DECODING, filters: [] }, (codec) => [
  "hwaccel:vaapi",
  `decodes:${codec}`,
]);

/** `scale_vaapi` scaling. */
const scaleVaapi: OpImpl<"Scale"> = {
  id: ImplId("scale.vaapi"),
  op: "Scale",
  on: "vaapi",
  takes: "vaapi",
  needs: () => ["filter:scale_vaapi"],
  variant: (op, frame) => scaleVariant(op, frame.depth),
  output: (op, frame) => ({
    ...frame,
    width: op.width,
    height: op.height,
    depth: op.depth,
    pixelFormat: surfaceFormat(op.depth),
  }),
  render: (op) => ({
    ...NOTHING,
    filters: [
      filter(
        "scale_vaapi",
        ["w", String(op.width)],
        ["h", String(op.height)],
        ["format", surfaceName(op.depth)],
      ),
    ],
  }),
  probes: scaleProbes,
};

/**
 * `tonemap_vaapi` from P010 HDR surfaces to BT.709 SDR in NV12; it needs the stream's mastering
 * display metadata.
 */
const toneMapVaapi: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.vaapi"),
  op: "ToneMap",
  on: "vaapi",
  takes: "vaapi",
  needs: () => ["filter:tonemap_vaapi"],
  variant: (_, frame) =>
    HDR_COLOURS.has(frame.colour) && frame.pixelFormat === "p010le"
      ? transferOf(frame.colour)
      : undefined,
  output: (_, frame) => ({ ...frame, colour: "sdr", depth: 8, pixelFormat: "nv12" }),
  render: () => ({
    ...NOTHING,
    filters: [
      filter("tonemap_vaapi", ["format", "nv12"], ["p", "bt709"], ["t", "bt709"], ["m", "bt709"]),
    ],
  }),
  probes: toneMapProbes,
};

/** VA-API's encoders: H.264 High, HEVC Main, AV1 Main. */
const encodeVaapi = encodeOn("vaapi", {
  h264: { name: "h264_vaapi", before: ["-profile:v", "high"], after: [] },
  hevc: { name: "hevc_vaapi", before: ["-profile:v", "main"], after: [] },
  av1: { name: "av1_vaapi", before: ["-profile:v", "main"], after: [] },
});

/** Every Quick Sync and VA-API row. */
export const INTEL_ROWS: ReadonlyArray<Row> = [
  row(decodeQsv),
  row(scaleQsv),
  row(toneMapQsv),
  row(encodeQsv),
  row(uploadTo("qsv", [["extra_hw_frames", "64"]], "qsv")),
  row(downloadFrom("qsv")),
  row(decodeVaapi),
  row(scaleVaapi),
  row(toneMapVaapi),
  row(encodeVaapi),
  row(uploadTo("vaapi", [], undefined)),
  row(downloadFrom("vaapi")),
];
