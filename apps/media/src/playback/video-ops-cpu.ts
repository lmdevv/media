/**
 * The CPU's rows: libavcodec's software decoders, the `bwdif` deinterlacer (`yadif` where a build
 * lacks it), `scale`, the `zscale` tone map, the image subtitle overlay, libass for text subtitles,
 * and libx264, libx265, and libsvtav1, a row each. A build listing proves these present, as they
 * touch no device. They are the floor every source falls back to, so they take any layout and
 * depth ffmpeg decodes, as software transcoding always has; closed lists guard the GPU rows instead.
 */
import { type Level, levelOf } from "./output-levels.ts";
import { DECODE_CLIPS, PROBE_CLIPS } from "./probe-clips.ts";
import {
  BURN_IMAGE_PROBES,
  BURN_TEXT_PROBES,
  canvasFit,
  DEINTERLACE_PROBES,
  deinterlaceVariant,
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

/**
 * A software deinterlacer: one frame for each frame (`send_frame`), only those the decoder flagged
 * interlaced (`deint=interlaced`), so soft-telecined and PsF pictures pass untouched, each in the
 * field order its own flag gives (`parity` left at `auto`). It keeps the frames' layout.
 */
const deinterlaceCpu = (id: string, name: "bwdif" | "yadif"): OpImpl<"Deinterlace"> => ({
  id: ImplId(id),
  op: "Deinterlace",
  on: "cpu",
  takes: "cpu",
  needs: () => [`filter:${name}`],
  variant: (_, input) => deinterlaceVariant(input),
  output: (_, input) => ({ ...input, scan: "progressive" }),
  render: () => ({
    ...NOTHING,
    filters: [filter(name, ["mode", "send_frame"], ["deint", "interlaced"])],
  }),
  probes: DEINTERLACE_PROBES,
});

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
 * is stretched to the picture it covers, or fitted inside it at its own aspect and centred
 * (`canvasFit`). Subtitles are SDR, so this comes after any tone map.
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
  render: (op, input) => {
    const size = [String(input.width), String(input.height)];
    const fitted = canvasFit(op.subtitle.codec) === "fit";

    return {
      ...NOTHING,
      filters: [
        filter(
          "overlay",
          ...(fitted
            ? [["x", "(main_w-overlay_w)/2"] as const, ["y", "(main_h-overlay_h)/2"] as const]
            : []),
          ["eof_action", "pass"],
          ["repeatlast", "0"],
        ),
      ],
      side: {
        input: op.subtitle.input,
        stream: op.subtitle.stream,
        calls: [
          filter(
            "scale",
            ...size,
            ...(fitted ? [["force_original_aspect_ratio", "decrease"] as const] : []),
          ),
        ],
      },
    };
  },
  probes: BURN_IMAGE_PROBES,
};

/**
 * The style plain text is drawn in, on the 384x288 script ffmpeg makes of SRT, WebVTT, and the
 * other plain formats: DejaVu Sans (the fallback font the image and the NixOS module ship) at 18,
 * a sixteenth of the picture's height, white with a black border a 240th of the height wide and a
 * half-transparent shadow, centred 16 of the script's lines above the bottom. Players draw plain
 * text near this size: mpv's default is 55 lines at 720, a thirteenth.
 */
const PLAIN_TEXT_STYLE = [
  "FontName=DejaVu Sans",
  "FontSize=18",
  "PrimaryColour=&H00FFFFFF",
  "OutlineColour=&H00000000",
  "BackColour=&H80000000",
  "BorderStyle=1",
  "Outline=1.2",
  "Shadow=0.6",
  "MarginV=16",
].join(",");

/**
 * Draws a text subtitle on the SDR picture with libass (`subtitles`), from the run's ASS file and
 * the fonts the media file carries, in the picture's own layout: ASS and SSA keep their styles,
 * positions, karaoke, and effects as libass renders them; plain text takes `PLAIN_TEXT_STYLE`.
 * libass scales the script to the picture, with the source's size as the size it was made for.
 */
const burnTextCpu: OpImpl<"BurnText"> = {
  id: ImplId("burn-text.cpu"),
  op: "BurnText",
  on: "cpu",
  takes: "cpu",
  needs: () => ["filter:subtitles"],
  variant: (_, input) => (input.colour === "sdr" ? "ass" : undefined),
  output: (_, input) => input,
  render: (op) => ({
    ...NOTHING,
    filters: [
      filter(
        "subtitles",
        ["filename", { file: "subtitle" }],
        ["fontsdir", { file: "fonts" }],
        [
          "original_size",
          `${String(op.subtitle.storage.width)}x${String(op.subtitle.storage.height)}`,
        ],
        ...(op.subtitle.style === "plain" ? [["force_style", PLAIN_TEXT_STYLE] as const] : []),
      ),
    ],
  }),
  probes: BURN_TEXT_PROBES,
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
 * How many pictures SVT-AV1 holds before it gives them back, as a live stream needs it. By default
 * it holds as many as its pipeline sizes itself for from the machine's cores: on a 32-thread host,
 * up to 351 pictures with Debian's SVT-AV1 2.3 and 221 with 4.1, 14.6 and 9.2 seconds at 24 fps.
 * The muxer waits at most 10 seconds for a stream's next packet (`max_interleave_delta`), then
 * writes the copied audio ahead into earlier fragments, so a fragment fetched alone opened with
 * seconds of silence. Three levels of parallelism (`lp`, which both versions read; neither reads
 * the longer name), an 8-picture mini-GOP (`hierarchical-levels=3`), and no look-ahead past it
 * hold 18 pictures before the first packet and at most 23 at once, whatever the host, with both
 * versions. On a 1688x720 film this kept SSIM within 0.0002 and the bitrate within 7 %, and
 * halved the frames encoded a second on a Ryzen 9 5950X (212 to 114 with 2.3).
 */
const SVT_AV1_LIVE: ReadonlyArray<string> = ["lp=3", "hierarchical-levels=3", "lookahead=0"];

/**
 * The 8-bit SDR encoder of each codec, each at a quality target near libx264's CRF 23 and a speed
 * that keeps up with a 1080p stream on a desktop CPU. libx265 closes its GOPs, or a forced
 * keyframe is a CRA picture whose leading pictures need the segment before, and makes each forced
 * keyframe an IDR frame (`forced-idr`): without it, a forced keyframe less than a second after a
 * scene cut's keyframe is dropped. On 30 s of a 1080p SDR film with Debian's ffmpeg 7.1 on a Ryzen
 * 9 5950X, libx265 `superfast` at CRF 23 scores an SSIM of 0.9878 against libx264's 0.9892 (CRF
 * 24: 0.9865; 28: 0.9801) with 81 % of its bytes, near 39 frames a second against libx264's 195.
 * SVT-AV1's presets above 9 warn of artifacts outside its real-time mode.
 */
const SOFTWARE_ENCODERS: Readonly<Record<OutputCodec, SoftwareEncoder>> = {
  h264: {
    name: "libx264",
    quality: ["-preset", "veryfast", "-profile:v", "high", "-crf", "23"],
    after: () => [],
  },
  hevc: {
    name: "libx265",
    quality: ["-preset", "superfast", "-profile:v", "main", "-crf", "23"],
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
    after: (level) => [
      "-svtav1-params",
      [...SVT_AV1_LIVE, ...(level === undefined ? [] : [`level=${String(level.tenths)}`])].join(
        ":",
      ),
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
  row(deinterlaceCpu("deinterlace.cpu", "bwdif")),
  // After `bwdif`, so a chain that costs the same takes `bwdif` while it is verified.
  row(deinterlaceCpu("deinterlace.cpu.yadif", "yadif")),
  row(scaleCpu),
  row(toneMapCpu),
  row(burnImageCpu),
  row(burnTextCpu),
  ...OUTPUT_CODECS.map((codec) => row(encodeCpu(codec))),
];
