/**
 * The rows of Intel's two GPU APIs, written for any Intel GPU and for AMD's VA-API: Quick Sync
 * (`qsv`, oneVPL derived from a VA-API device) and VA-API (`vaapi`). Each decodes, deinterlaces,
 * scales, tone-maps (with libplacebo on Vulkan, or the GPU's own tone map), draws an image
 * subtitle, and encodes H.264, HEVC, and AV1 (a row per codec) on the device, and moves frames to
 * and from CPU memory in NV12 or P010. Which of these a device does is evidence, never assumed: a
 * row only says what it may try.
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
  type FilterCall,
  type Frame,
  encodeRowId,
  encodesTarget,
  filter,
  fusing,
  type GpuDomain,
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
  SDR_BT709,
  STRIP_DOLBY_VISION_METADATA,
  STRIP_DYNAMIC_HDR_METADATA,
  STRIP_HDR_METADATA,
  surfaceDepth,
  surfaceFormat,
  visibleCanvas,
  type Size,
  statedCanvas,
  drawnCanvas,
  TAG_SDR_BT709,
  toneMapTransfer,
} from "./video-ops.ts";

/**
 * libplacebo's tone map of `frame` to SDR BT.709 in limited range, NV12, as the reference the table
 * of source colours is judged against (`colour-patches.mjs` in verify-media): ITU-R BT.2390's EETF,
 * with no peak detection or contrast recovery, so a picture maps the same in every segment and
 * after every seek, and with libplacebo's perceptual gamut mapping. It applies a Dolby Vision RPU
 * to Dolby Vision's IPT-PQ-c2 alone (`apply_dolbyvision`), the only way either ffmpeg build reads
 * profile 5; a base layer the table maps as what it is (7, 8.1, 8.4) maps as the CPU's and the
 * GPU's own tone maps map it, with its RPU left unread.
 */
const placeboSdr = (frame: Frame): FilterCall =>
  filter(
    "libplacebo",
    ["format", "nv12"],
    ["colorspace", "bt709"],
    ["color_primaries", "bt709"],
    ["color_trc", "bt709"],
    ["range", "tv"],
    ["tonemapping", "bt.2390"],
    ["peak_detect", "0"],
    ["contrast_recovery", "0"],
    ["apply_dolbyvision", frame.colour.signal === "dovi" ? "1" : "0"],
    ["shader_cache", { file: "shaders" }],
  );

/**
 * The transfer libplacebo maps from, what changes whether it works: PQ for HDR10's kin and for
 * Dolby Vision's IPT-PQ-c2, whose RPU's reshaping is libplacebo's shader arithmetic, the same on
 * every device, so the PQ probe proves it; HLG; none for SDR.
 */
const placeboTransfer = (frame: Frame): "pq" | "hlg" | undefined =>
  frame.colour.signal === "dovi" ? "pq" : toneMapTransfer(frame);

/**
 * What libplacebo's row sustains on the Arc A380, by output height, mapping 4K HDR10 HEVC decoded on
 * the GPU: the lowest of two runs each on ffmpeg 9.0.2 and the image's 7.1.5, at a load under 3.
 * Quick Sync's path: 181, 145, 89, 57, and 29 frames a second at 480, 720, 1080, 1440, and 2160
 * lines (7.1's; 9 reached 229 to 41), against Intel's own 150 up to 1440 lines and 102 at 2160.
 * VA-API's: 149, 121, 91, 66, and 26 (9's at 480 and 2160, 7.1's between), against Intel's own 248
 * to 96. For a 24 fps film it keeps up (`KEEPS_UP`) up to 1080 lines on Quick Sync and 1440 on
 * VA-API, and above that Intel's own tone map is the cheaper choice.
 */
const PLACEBO_THROUGHPUT: Readonly<
  Record<GpuDomain, ReadonlyArray<readonly [height: number, framesPerSecond: number]>>
> = {
  qsv: [
    [480, 181],
    [720, 145],
    [1080, 89],
    [1440, 57],
    [2160, 29],
  ],
  vaapi: [
    [480, 149],
    [720, 121],
    [1080, 91],
    [1440, 66],
    [2160, 26],
  ],
};

/** The layouts libplacebo's row takes: P010, as a GPU's surfaces download, and 10-bit planar. */
const PLACEBO_FORMATS: ReadonlySet<string | undefined> = new Set(["p010le", "yuv420p10le"]);

/**
 * libplacebo's tone map (`placeboSdr`) of PQ, HLG, and Dolby Vision frames in CPU memory, for
 * `domain`'s chains. The dynamic HDR metadata goes first (`STRIP_DYNAMIC_HDR_METADATA`), and a base
 * layer's Dolby Vision RPU with it, so libplacebo maps a source as the static base the CPU's and the
 * GPU's own tone maps map. The frames are uploaded to a Vulkan device derived from `domain`'s
 * (`hwupload=derive_device=vulkan`), mapped there, and downloaded as NV12, tagged SDR BT.709
 * (`TAG_SDR_BT709`) and without the source's HDR metadata (`STRIP_HDR_METADATA`). The derivation
 * finds the Vulkan device by the render node's DRM device, so it is the same GPU: never another
 * one, and never a software rasteriser, which has no DRM node (with the GPU's Vulkan driver
 * missing, the derivation fails and the probe with it); libplacebo runs on the device of the
 * frames it is handed. A chain places it between moves from and back to `domain`'s memory, which
 * the planner inserts and counts, with its own upload and download (`transfers`). On the Arc A380 a
 * Vulkan device could not import VA-API's surfaces in place (VK_ERROR_OUT_OF_DEVICE_MEMORY with a
 * 256 MiB BAR), so the frames go through CPU memory. Intel's tone map, Quick Sync's and VA-API's
 * alike, stands in for it where it cannot run (`fallbackFor`): it maps the HDR10 patches 100 cd/m²
 * to luma 130 and 0.5 cd/m² to 3 where BT.2390 gives 174 and 16 (CIEDE2000 up to 18 in the
 * mid-tones), the near-black the GPU paths crushed.
 */
const placeboOn = (domain: GpuDomain): OpImpl<"ToneMap"> => ({
  id: ImplId(`tonemap.${domain}.placebo`),
  op: "ToneMap",
  on: domain,
  takes: "cpu",
  needs: () => [
    "hwaccel:vulkan",
    "filter:sidedata",
    "filter:hwupload",
    "filter:libplacebo",
    "filter:hwdownload",
    "filter:setparams",
  ],
  variant: (_, frame) =>
    PLACEBO_FORMATS.has(frame.pixelFormat) ? placeboTransfer(frame) : undefined,
  output: (_, frame) => ({ ...frame, colour: SDR_BT709, depth: 8, pixelFormat: "nv12" }),
  render: (_, frame) => ({
    ...NOTHING,
    filters: [
      ...STRIP_DYNAMIC_HDR_METADATA,
      ...(frame.colour.signal === "dovi" ? [] : STRIP_DOLBY_VISION_METADATA),
      placeboSdr(frame),
      filter("format", "nv12"),
      TAG_SDR_BT709,
      ...STRIP_HDR_METADATA,
    ],
  }),
  probes: placeboProbes,
  transfers: { device: "vulkan", count: 2 },
  throughput: PLACEBO_THROUGHPUT[domain],
});

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
  vulkanArgs: (device) => [
    "-init_hw_device",
    `vaapi=va:${device}`,
    "-init_hw_device",
    "qsv=hw@va",
    "-init_hw_device",
    "vulkan=vk@hw",
    "-filter_hw_device",
    "vk",
  ],
  needs: ["hwaccel:qsv", "hwaccel:vaapi"],
  filterDurations: "untrusted",
};

/** VA-API on `VAAPI_DEVICE`. Its filters keep frames' durations in their timestamps' time base. */
export const VAAPI: DomainSpec = {
  device: (config) => config.vaapiDevice,
  deviceArgs: (device) => ["-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va"],
  vulkanArgs: (device) => [
    "-init_hw_device",
    `vaapi=va:${device}`,
    "-init_hw_device",
    "vulkan=vk@va",
    "-filter_hw_device",
    "vk",
  ],
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

/**
 * libplacebo's probes, which read the mapped picture back (`readbackVerdict`): frames from a Vulkan
 * device are proven by what they show, not only by coming out.
 */
const placeboProbes: ReadonlyArray<ProbeCase<"ToneMap">> = [
  { op: Op.ToneMap(), clip: "hevc-pq", runs: 1, readback: "picture" },
  { op: Op.ToneMap(), clip: "hevc-hlg", runs: 1, readback: "picture" },
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

/**
 * The colour `vpp_qsv` must state as its output to leave SDR `frame` in its own: by default it
 * converts samples to limited range and BT.709's matrix and primaries but leaves the frame's tags,
 * so the samples no longer match them. On an Arc A380 under ffmpeg 7.1, full-range patches came
 * out with black at 16, and BT.601's 75 % cyan 9 apart in CIEDE2000; stated as the source's, every
 * patch matched (`out_color_matrix` alone left the primaries converted). Nothing for HDR frames,
 * which a tone map states, or for BT.709 in limited range or a frame that states nothing, which
 * keep main's arguments.
 */
const keptColour = (frame: Frame): FilterCall["args"] => {
  const { colour } = frame;

  const stated: ReadonlyArray<readonly [string, string | undefined]> = [
    ["out_color_matrix", colour.matrix],
    ["out_color_primaries", colour.primaries],
    ["out_color_transfer", colour.transfer],
  ];

  const converted = stated.some(([, value]) => value !== undefined && value !== "bt709");

  if (colour.signal !== "sdr" || (!converted && colour.range === "limited")) return [];

  return [
    ...stated.flatMap(([option, value]): FilterCall["args"] =>
      value === undefined || !converted ? [] : [[option, value]],
    ),
    ...(colour.range === "full" ? [["out_range", "full"] as const] : []),
  ];
};

/**
 * `vpp_qsv` scaling, its output stated in an SDR source's own colour (`keptColour`); it fuses with
 * a following tone map into one `vpp_qsv`, whose tone map then states BT.709.
 */
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
  render: (op, frame) => ({
    ...NOTHING,
    filters: [
      fusing(
        "vpp_qsv",
        ["w", String(op.width)],
        ["h", String(op.height)],
        ["format", surfaceName(op.depth)],
        ...keptColour(frame),
      ),
    ],
  }),
  probes: scaleProbes,
};

/**
 * `vpp_qsv`'s tone map from P010 PQ and HLG surfaces to BT.709 SDR in NV12, where libplacebo's
 * cannot run (`fallbackFor`). `vpp_qsv` hands the driver the frames' mastering display and content
 * light levels alone, so dynamic HDR metadata changes nothing it maps (on Apple's HDR10+ sample, 120
 * frames at 720 lines came out byte for byte the same without it, under ffmpeg 7.1 and 9), and it
 * fuses with the scale before it into one pass. It leaves the source's colour on the frames under Debian's ffmpeg
 * 7.1 and its HDR metadata under 7.1 and 9, which encoders then write into the stream, so an SDR
 * stream would say PQ and BT.2020: the row tags its frames SDR BT.709 in limited range
 * (`TAG_SDR_BT709`) and drops that metadata (`STRIP_HDR_METADATA`).
 */
const toneMapQsv: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.qsv"),
  op: "ToneMap",
  on: "qsv",
  takes: "qsv",
  fallbackFor: ImplId("tonemap.qsv.placebo"),
  needs: () => ["filter:vpp_qsv", "filter:setparams", "filter:sidedata"],
  variant: (_, frame) => (frame.pixelFormat === "p010le" ? toneMapTransfer(frame) : undefined),
  output: (_, frame) => ({ ...frame, colour: SDR_BT709, depth: 8, pixelFormat: "nv12" }),
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
      TAG_SDR_BT709,
      ...STRIP_HDR_METADATA,
    ],
  }),
  probes: toneMapProbes,
};

/** `value` to the even number at or below it: NV12 surfaces and their places keep whole chroma. */
const evenBelow = (value: number): number => 2 * Math.floor(value / 2);

/**
 * The two canvases a GPU row uploads a subtitle on, the sizes shown to come through an upload
 * intact. On an Arc A380, VA-API's upload (iHD 25.2.3 under ffmpeg 7.1, iHD 26.3.5 under ffmpeg 9)
 * tears BGRA frames of some sizes into slanted bands: at 480 rows, widths from 704 to 1760 in six
 * bands, 853 and 854 among them, and widths 928 to 992 at 360, 576, and 720 rows. Every even width
 * at 1080 rows, and 720x576, came back from an upload and a download byte for byte; Quick Sync's
 * upload tore at no size tried.
 */
const HD_CANVAS: Size = { width: 1920, height: 1080 };

const SD_CANVAS: Size = { width: 720, height: 576 };

/** How a GPU row hands an image subtitle to the device, and where its overlay draws it. */
interface Upload {
  /** The fixed size the subtitle's frames are scaled to first, whatever canvas they arrive on. */
  readonly canvas: Size;
  /** The part of `canvas` uploaded: its middle, where the picture shows less than all of it. */
  readonly shown: Size;
  /** The overlay's options that scale and place the uploaded part on the picture. */
  readonly place: ReadonlyArray<readonly [string, string]>;
}

/**
 * A GPU row scales a subtitle's frames to a fixed canvas, uploads it, and the device's overlay
 * scales it to the picture: it scales no subtitle up past its canvas on the CPU, where that costs
 * every frame, and uploads no size taken from the picture (`HD_CANVAS`). The canvas a stream has is
 * learned only while it plays, so the fixed one is the canvas the service states (`statedCanvas`):
 * a 1920x1080 PGS canvas passes through untouched, a 720p one is scaled up to it, and a 3840x2160
 * one is scaled down to it, drawn softer than the CPU row draws it. A subtitle with no stated
 * canvas (DVB, XSUB) is stretched over the picture from 1920x1080, or from 720x576 over a picture
 * of 576 rows or fewer. A PGS canvas is placed at the picture's height and centred, as the CPU
 * row places it (`drawnCanvas`), only the middle the picture shows uploaded; every size and place
 * is in even samples, at most one sample from the CPU row's. On an Arc A380, under ffmpeg 7.1 and
 * 9, Quick Sync's and VA-API's scaling put each band edge of a 320x240 canvas over a 640x360
 * picture on the same column as the CPU's `scale` and `overlay`.
 */
const uploadOf = (codec: string, picture: Size): Upload => {
  if (canvasFit(codec) === "stretch") {
    const canvas =
      statedCanvas(codec) ?? (picture.height > SD_CANVAS.height ? HD_CANVAS : SD_CANVAS);

    return {
      canvas,
      shown: canvas,
      place: [
        ["w", "main_w"],
        ["h", "main_h"],
      ],
    };
  }

  const canvas = statedCanvas(codec) ?? HD_CANVAS;
  const drawn = drawnCanvas(codec, picture);
  const width = evenBelow(Math.min(drawn.width, picture.width));
  const height = evenBelow(picture.height);

  return {
    canvas,
    shown:
      drawn.width > picture.width
        ? {
            width: Math.max(2, 2 * Math.round((canvas.width * picture.width) / drawn.width / 2)),
            height: canvas.height,
          }
        : canvas,
    place: [
      ["x", String(evenBelow((picture.width - width) / 2))],
      ["y", String(evenBelow((picture.height - height) / 2))],
      ["w", String(width)],
      ["h", String(height)],
    ],
  };
};

/**
 * The primaries `frame` states, put back on it after VA-API's overlay cleared them for the blend
 * (`burnImageOn`): BT.709 on a tone-mapped picture, an SDR source's own; nothing for a source that
 * states none, whose stream names none either.
 */
const restoredPrimaries = (frame: Frame): ReadonlyArray<FilterCall> =>
  frame.colour.primaries === undefined
    ? []
    : [filter("setparams", ["color_primaries", frame.colour.primaries])];

/**
 * An image subtitle drawn on `domain`'s SDR NV12 surfaces by `overlay`, so the picture never leaves
 * the device: the subtitle's own frames, small and sparse, are decoded on the CPU into BGRA,
 * scaled to a fixed size (`uploadOf`), which a frame whose canvas changed mid-stream keeps,
 * uploaded, and scaled and blended on the device. Both
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
 * names none: its row clears the picture's primaries for the blend and states the frame's own
 * again after it (`restoredPrimaries`).
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
    frame.colour.signal === "sdr" &&
    frame.pixelFormat === "nv12" &&
    op.subtitle.frame.memory === "cpu"
      ? "bitmap/nv12"
      : undefined,
  output: (_, frame) => frame,
  render: (op, frame) => {
    const upload = uploadOf(op.subtitle.codec, { width: frame.width, height: frame.height });

    const side = {
      input: op.subtitle.input,
      stream: op.subtitle.stream,
      calls: [
        filter("scale", String(upload.canvas.width), String(upload.canvas.height)),
        ...visibleCanvas(upload.canvas, upload.shown),
        filter("format", "bgra"),
        filter("hwupload"),
      ],
    };

    return {
      ...NOTHING,
      filters: [
        filter(overlay, ...upload.place, ["eof_action", "pass"], ["repeatlast", "0"]),
        ...(overlay === "overlay_vaapi" ? restoredPrimaries(frame) : []),
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
    frame.colour.signal === "sdr" &&
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
 * The variant VA-API's tone map works from: the transfer, and for PQ whether the stream carries
 * mastering display metadata, which `tonemap_vaapi` refuses frames without (`pq-bare`, probed on
 * a clip that has none), so a plan for such a file is right the first time.
 */
const vaapiToneMapVariant = (frame: Frame): string | undefined => {
  const transfer = toneMapTransfer(frame);

  return transfer === "pq" && frame.colour.mastering === "absent" ? "pq-bare" : transfer;
};

/**
 * `tonemap_vaapi` from P010 PQ and HLG surfaces to BT.709 SDR in NV12, where libplacebo's cannot
 * run (`fallbackFor`); it needs the stream's mastering display metadata (`vaapiToneMapVariant`) and
 * reads no dynamic metadata, which the row removes first all the same, as every tone map does. The
 * row tags the frames BT.709 limited range (`TAG_SDR_BT709`), which they already say: without it,
 * under Debian's ffmpeg 7.1, libass after the download drew ASS orange at Y 148 and red at 74,
 * BT.601's values, where the CPU and Quick Sync paths draw BT.709's 141 and 63. It keeps the
 * source's HDR metadata on its frames, which encoders write into the stream: the row drops it
 * (`STRIP_HDR_METADATA`).
 */
const toneMapVaapi: OpImpl<"ToneMap"> = {
  id: ImplId("tonemap.vaapi"),
  op: "ToneMap",
  on: "vaapi",
  takes: "vaapi",
  fallbackFor: ImplId("tonemap.vaapi.placebo"),
  needs: () => ["filter:tonemap_vaapi", "filter:setparams", "filter:sidedata"],
  variant: (_, frame) => (frame.pixelFormat === "p010le" ? vaapiToneMapVariant(frame) : undefined),
  output: (_, frame) => ({ ...frame, colour: SDR_BT709, depth: 8, pixelFormat: "nv12" }),
  render: () => ({
    ...NOTHING,
    filters: [
      ...STRIP_DYNAMIC_HDR_METADATA,
      filter("tonemap_vaapi", ["format", "nv12"], ["p", "bt709"], ["t", "bt709"], ["m", "bt709"]),
      TAG_SDR_BT709,
      ...STRIP_HDR_METADATA,
    ],
  }),
  probes: [...toneMapProbes, { op: Op.ToneMap(), clip: "hevc-pq-bare", runs: 1 }],
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
  row(placeboOn("qsv")),
  row(toneMapQsv),
  row(burnImageOn("qsv", "overlay_qsv")),
  ...encodeQsv,
  row(uploadTo("qsv", [["extra_hw_frames", "64"]], "qsv")),
  row(downloadFrom("qsv")),
  row(decodeVaapi),
  row(deinterlaceVaapi),
  row(scaleVaapi),
  row(placeboOn("vaapi")),
  row(toneMapVaapi),
  row(burnImageOn("vaapi", "overlay_vaapi")),
  ...encodeVaapi,
  row(uploadTo("vaapi", [], undefined)),
  row(downloadFrom("vaapi")),
];
