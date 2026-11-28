/**
 * The rows of Intel's two GPU APIs, written for any Intel GPU and for AMD's VA-API: Quick Sync
 * (`qsv`, oneVPL derived from a VA-API device) and VA-API (`vaapi`). Each decodes, deinterlaces,
 * scales, tone-maps, draws an image subtitle, and encodes H.264, HEVC, and AV1 (a row per codec)
 * on the device, and moves frames to and from CPU memory in NV12 or P010. Which of these a device
 * does is evidence, never assumed: a row only says what it may try.
 */
import { type Level, levelOf } from "./output-levels.ts";
import { DECODE_CLIPS, PROBE_CLIPS } from "./probe-clips.ts";
import {
  BURN_IMAGE_PROBES,
  type BuildFeature,
  canvasFit,
  DEINTERLACE_PROBES,
  deinterlaceVariant,
  type Domain,
  type DomainSpec,
  encodeProbes,
  encodeRowId,
  encodesTarget,
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
  type ProbeCase,
  type Rendering,
  row,
  type Row,
  surfaceDepth,
  surfaceFormat,
  transferOf,
  visibleCanvas,
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
 *
 * Its processing filters (`vpp_qsv`, `scale_qsv`, `deinterlace_qsv`, `overlay_qsv`, all built on
 * libavfilter's `qsvvpp`) time their output in 1/frame rate, but ffmpeg 7.1.x, Debian's in the
 * image, then copies each input frame's duration over in the input's time base (FFmpeg 578ac59887,
 * in 7.1 through 7.1.5; 8.0 has the fix, bc991ca048). A 24 fps MP4 counted in 1/12288 s then has
 * frames 512 ticks long, so ffmpeg's constant-rate output shows its first picture for 21 s.
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
  filterDurations: "untrusted",
};

/** VA-API on `VAAPI_DEVICE`. Its filters keep frames' durations in their timestamps' time base. */
export const VAAPI: DomainSpec = {
  device: (config) => config.vaapiDevice,
  deviceArgs: (device) => ["-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va"],
  needs: ["hwaccel:vaapi"],
  filterDurations: "trusted",
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

/**
 * `vpp_qsv`'s motion-adaptive deinterlacer at the source's frame rate. Quick Sync takes each
 * surface's structure from its frame's flags (interlaced, and which field is first), so a frame
 * flagged progressive passes untouched; every frame comes out at its own time, from its first
 * field, under ffmpeg 7.1 and 9. It fuses with the scale and tone map after it into one
 * `vpp_qsv`, which deinterlaces before it scales.
 */
const deinterlaceQsv: OpImpl<"Deinterlace"> = {
  id: ImplId("deinterlace.qsv"),
  op: "Deinterlace",
  on: "qsv",
  takes: "qsv",
  needs: () => ["filter:vpp_qsv"],
  variant: (_, frame) => (SURFACE_DEPTHS.has(frame.depth) ? deinterlaceVariant(frame) : undefined),
  output: (_, frame) => ({ ...frame, scan: "progressive" }),
  render: () => ({
    ...NOTHING,
    filters: [fusing("vpp_qsv", ["deinterlace", "advanced"], ["rate", "frame"])],
  }),
  probes: DEINTERLACE_PROBES,
};

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

/**
 * `vpp_qsv`'s tone map from P010 HDR surfaces to BT.709 SDR in NV12. `vpp_qsv` leaves the source's
 * colour on the frames under Debian's ffmpeg 7.1 and its mastering display and content light
 * levels under 7.1 and 9, which every encoder then writes into the stream, so an SDR stream would
 * say PQ and BT.2020: the row tags its frames BT.709 (`setparams`) and drops that metadata.
 */
const toneMapQsv: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.qsv"),
  op: "ToneMap",
  on: "qsv",
  takes: "qsv",
  needs: () => ["filter:vpp_qsv", "filter:setparams", "filter:sidedata"],
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
      filter(
        "setparams",
        ["color_primaries", "bt709"],
        ["color_trc", "bt709"],
        ["colorspace", "bt709"],
      ),
      filter("sidedata", ["mode", "delete"], ["type", "MASTERING_DISPLAY_METADATA"]),
      filter("sidedata", ["mode", "delete"], ["type", "CONTENT_LIGHT_LEVEL"]),
    ],
  }),
  probes: toneMapProbes,
};

/**
 * Where an overlay on a GPU puts the subtitle's canvas, uploaded at its own size, as expressions of
 * the picture's size (`main_w`) and the canvas's (`overlay_iw`): stretched over the picture, or,
 * cropped first to the columns the picture shows (`visibleCanvas`), scaled to the picture's height
 * and centred (`canvasFit`). On an Arc A380, under ffmpeg 7.1 and 9, Quick Sync's and VA-API's
 * scaling put each band edge of a 320x240 canvas over a 640x360 picture on the same column as the
 * CPU's `scale` and `overlay`.
 */
const overlayPlace = (codec: string): ReadonlyArray<readonly [string, string]> =>
  canvasFit(codec) === "height"
    ? [
        ["x", "(main_w-overlay_w)/2"],
        ["y", "(main_h-overlay_h)/2"],
        ["w", "overlay_iw*main_h/overlay_ih"],
        ["h", "main_h"],
      ]
    : [
        ["w", "main_w"],
        ["h", "main_h"],
      ];

/**
 * An image subtitle drawn on `domain`'s SDR NV12 surfaces by `overlay`, so the picture never leaves
 * the device: the subtitle's own frames, small and sparse, are decoded on the CPU into BGRA at the
 * canvas's size (`subtitleCanvas`, held there by a `scale` that passes them on untouched unless a
 * packet changed it), uploaded, and scaled and blended on the device. Both
 * overlays take BGRA with straight alpha per pixel, as ffmpeg hands image subtitles to filters:
 * under ffmpeg 7.1 and 9 on an Arc A380, a band of white at half opacity over gray came out halfway
 * between the two (193 for 191.5), and a premultiplied one gray. Between captions and before the
 * first, ffmpeg repeats the subtitle's last frame as the picture advances, so the overlay never
 * waits on the sparse stream; after its end the picture passes on alone. Those repeats run ahead
 * of the picture while it decodes, and after a seek by the second of subtitle frames kept before
 * the picture starts (`transcode-command.ts`), each holding an uploaded surface until the overlay
 * pairs it: the upload's pool grows to that, where a fixed one of 16 surfaces ran out (ENOMEM) on
 * a seek into a DVD caption and at the end of the file, under both builds. VA-API's overlay, on the
 * same card with iHD 26.3.5 under both builds, blends the subtitle's black as full range (Y 0, so a
 * half-transparent border lands 8 levels dark) over a picture whose frames name BT.709 primaries,
 * as a tone-mapped picture's and many SDR files' do, and as limited range (Y 16) over one that
 * names none: its row clears the picture's primaries for the blend, so the stream names none.
 */
const burnImageOn = (
  domain: GpuDomain,
  overlay: "overlay_qsv" | "overlay_vaapi",
): OpImpl<"BurnImage"> => ({
  id: ImplId(`burn-image.${domain}`),
  op: "BurnImage",
  on: domain,
  takes: domain,
  needs: () =>
    overlay === "overlay_vaapi"
      ? [`filter:${overlay}`, "filter:hwupload", "filter:setparams"]
      : [`filter:${overlay}`, "filter:hwupload"],
  variant: (op, frame) =>
    frame.colour === "sdr" && frame.pixelFormat === "nv12" && op.subtitle.frame.memory === "cpu"
      ? "bitmap/nv12"
      : undefined,
  output: (_, frame) => frame,
  render: (op, frame) => {
    const side = {
      input: op.subtitle.input,
      stream: op.subtitle.stream,
      calls: [
        filter("scale", String(op.subtitle.frame.width), String(op.subtitle.frame.height)),
        ...(canvasFit(op.subtitle.codec) === "height"
          ? visibleCanvas(op.subtitle.frame, frame.width, frame.height)
          : []),
        filter("format", "bgra"),
        filter("hwupload"),
      ],
    };

    return {
      ...NOTHING,
      filters: [
        filter(
          overlay,
          ...overlayPlace(op.subtitle.codec),
          ["eof_action", "pass"],
          ["repeatlast", "0"],
        ),
      ],
      side:
        overlay === "overlay_vaapi"
          ? { ...side, picture: [filter("setparams", ["color_primaries", "unknown"])] }
          : side,
    };
  },
  probes: BURN_IMAGE_PROBES,
});

/**
 * One codec's GPU encoder: its name, the options before and after the bitrate, and how it states a
 * level the plan has.
 */
interface GpuEncoder {
  readonly name: string;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
  readonly level: (level: Level) => ReadonlyArray<string>;
}

/**
 * The row of `domain`'s encoder of `codec`: a fixed bitrate from 8-bit SDR NV12 surfaces. On the
 * Arc A380 every one of them, with ffmpeg 9 and Debian's 7.1, put an IDR frame (H.264, HEVC) or a
 * key frame (AV1) exactly at each forced keyframe.
 */
const encodeOn = (
  domain: GpuDomain,
  codec: OutputCodec,
  encoder: GpuEncoder,
): OpImpl<"Encode"> => ({
  id: encodeRowId(domain, codec),
  op: "Encode",
  on: domain,
  takes: domain,
  needs: () => [`encoder:${encoder.name}`],
  variant: (op, frame) =>
    encodesTarget(codec, op.target) &&
    frame.colour === "sdr" &&
    frame.scan === "progressive" &&
    frame.pixelFormat === "nv12"
      ? `${String(op.target.depth)}/cbr`
      : undefined,
  output: (_, frame) => frame,
  render: (op) => ({
    ...NOTHING,
    output: [
      "-c:v",
      encoder.name,
      ...encoder.before,
      ...(op.level === undefined ? [] : levelArgs(codec, op.level, encoder)),
      "-b:v",
      String(op.bitrate),
      "-maxrate",
      String(op.bitrate),
      "-bufsize",
      String(op.bitrate * 2),
      ...encoder.after,
    ],
  }),
  probes: encodeProbes(codec),
});

/** How `encoder` states the level in ffprobe's units `idc`; nothing for a level no table lists. */
const levelArgs = (codec: OutputCodec, idc: number, encoder: GpuEncoder): ReadonlyArray<string> => {
  const level = levelOf(codec, idc);

  return level === undefined ? [] : encoder.level(level);
};

/** Each of `domain`'s encoders as a row of its own. */
const encodesOn = (
  domain: GpuDomain,
  encoders: Readonly<Record<OutputCodec, GpuEncoder>>,
): ReadonlyArray<Row> =>
  OUTPUT_CODECS.map((codec) => row(encodeOn(domain, codec, encoders[codec])));

/** States no level: H.264 encodes have no level table. */
const NO_LEVEL = (): ReadonlyArray<string> => [];

/**
 * Quick Sync's encoders; `forced_idr` makes each forced keyframe an IDR frame. oneVPL takes HEVC's
 * and AV1's level as its tenths (21 for 2.1).
 */
const encodeQsv = encodesOn("qsv", {
  h264: {
    name: "h264_qsv",
    before: ["-preset", "veryfast"],
    after: ["-forced_idr", "1"],
    level: NO_LEVEL,
  },
  hevc: {
    name: "hevc_qsv",
    before: ["-preset", "veryfast", "-profile:v", "main"],
    after: ["-forced_idr", "1"],
    level: (level) => ["-level", String(level.tenths)],
  },
  av1: {
    name: "av1_qsv",
    before: ["-preset", "veryfast", "-profile:v", "main"],
    after: ["-forced_idr", "1"],
    level: (level) => ["-level", String(level.tenths)],
  },
});

const decodeVaapi = decodeOn("vaapi", { input: VAAPI_DECODING, filters: [] }, (codec) => [
  "hwaccel:vaapi",
  `decodes:${codec}`,
]);

/**
 * `deinterlace_vaapi`'s bob at the source's frame rate: only frames flagged interlaced (`auto`),
 * each from the field its flag says is first. The driver's default, motion-adaptive, needs the
 * frame before: on an Arc A380 with iHD 25.2 and 26.3, under ffmpeg 7.1 and 9, it gave no frame
 * for each run's first and stamped every other with the next frame's time, showing the field
 * before, so each seek started a frame late. Bob reads one frame: every frame comes out, on time.
 * Against 50p pictures woven to 25i it scored 35.0 dB, `bwdif` 36.5.
 */
const deinterlaceVaapi: OpImpl<"Deinterlace"> = {
  id: ImplId("deinterlace.vaapi"),
  op: "Deinterlace",
  on: "vaapi",
  takes: "vaapi",
  needs: () => ["filter:deinterlace_vaapi"],
  variant: (_, frame) => (SURFACE_DEPTHS.has(frame.depth) ? deinterlaceVariant(frame) : undefined),
  output: (_, frame) => ({ ...frame, scan: "progressive" }),
  render: () => ({
    ...NOTHING,
    filters: [filter("deinterlace_vaapi", ["mode", "bob"], ["rate", "frame"], ["auto", "1"])],
  }),
  probes: DEINTERLACE_PROBES,
};

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
 * display metadata. The row tags the frames BT.709 limited range (`setparams`), which they already
 * say: without it, under Debian's ffmpeg 7.1, libass after the download drew ASS orange at Y 148
 * and red at 74, BT.601's values, where the CPU and Quick Sync paths draw BT.709's 141 and 63.
 */
const toneMapVaapi: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.vaapi"),
  op: "ToneMap",
  on: "vaapi",
  takes: "vaapi",
  needs: () => ["filter:tonemap_vaapi", "filter:setparams"],
  variant: (_, frame) =>
    HDR_COLOURS.has(frame.colour) && frame.pixelFormat === "p010le"
      ? transferOf(frame.colour)
      : undefined,
  output: (_, frame) => ({ ...frame, colour: "sdr", depth: 8, pixelFormat: "nv12" }),
  render: () => ({
    ...NOTHING,
    filters: [
      filter("tonemap_vaapi", ["format", "nv12"], ["p", "bt709"], ["t", "bt709"], ["m", "bt709"]),
      filter(
        "setparams",
        ["color_primaries", "bt709"],
        ["color_trc", "bt709"],
        ["colorspace", "bt709"],
        ["range", "tv"],
      ),
    ],
  }),
  probes: toneMapProbes,
};

/**
 * VA-API's encoders: H.264 High, HEVC Main, AV1 Main. They take a level in ffprobe's units
 * (`general_level_idc`, `seq_level_idx`).
 */
const encodeVaapi = encodesOn("vaapi", {
  h264: { name: "h264_vaapi", before: ["-profile:v", "high"], after: [], level: NO_LEVEL },
  hevc: {
    name: "hevc_vaapi",
    before: ["-profile:v", "main"],
    after: [],
    level: (level) => ["-level", String(level.idc)],
  },
  av1: {
    name: "av1_vaapi",
    before: ["-profile:v", "main"],
    after: [],
    level: (level) => ["-level", String(level.idc)],
  },
});

/** Every Quick Sync and VA-API row. */
export const INTEL_ROWS: ReadonlyArray<Row> = [
  row(decodeQsv),
  row(deinterlaceQsv),
  row(scaleQsv),
  row(toneMapQsv),
  row(burnImageOn("qsv", "overlay_qsv")),
  ...encodeQsv,
  row(uploadTo("qsv", [["extra_hw_frames", "64"]], "qsv")),
  row(downloadFrom("qsv")),
  row(decodeVaapi),
  row(deinterlaceVaapi),
  row(scaleVaapi),
  row(toneMapVaapi),
  row(burnImageOn("vaapi", "overlay_vaapi")),
  ...encodeVaapi,
  row(uploadTo("vaapi", [], undefined)),
  row(downloadFrom("vaapi")),
];
