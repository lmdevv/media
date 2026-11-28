/**
 * The generated clips capability probes read: ten frames at 320x240, one per codec and layout a
 * decoder row tries, plus HDR clips for tone maps, interlaced clips for deinterlacers, and a gray
 * clip subtitle rows draw on. The service writes each once with software encoders; a clip this
 * build cannot make proves nothing, and the keys that need it wait for a real source. Subtitle rows
 * also read a canvas or a script, and their probes read the first picture back (`readbackVerdict`).
 */
import {
  type BuildFeature,
  type ClipName,
  type Colour,
  type Readback,
  SDR_BT709,
  type SourceVideo,
} from "./video-ops.ts";

/** What a clip is and how it is made. */
export interface ProbeClip {
  readonly source: SourceVideo;
  /** The encoder that makes it. */
  readonly needs: BuildFeature;
  /** ffmpeg arguments that write it, before the output path. */
  readonly args: ReadonlyArray<string>;
}

const SIZE = { width: 320, height: 240 } as const;

const PICTURE = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1"];

/**
 * Ten interlaced frames: twenty pictures woven in pairs, the top field from the earlier one, and
 * coded as fields (`ildct`), so each decoded frame is flagged interlaced and top field first.
 */
const WOVEN = [
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x240:rate=20:duration=1",
  "-vf",
  "tinterlace=interleave_top,setfield=tff",
  "-flags",
  "+ildct+ilme",
];

const PQ =
  "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc";

const HLG =
  "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc";

/**
 * HDR10 static metadata, carried in the stream so decoded frames hold it: VA-API's tone map
 * refuses frames without mastering display metadata.
 */
const HDR10_X265 =
  "log-level=error:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400";

/** The colour of the HDR clips: BT.2020 in limited range, with HDR10's metadata or none. */
const hdr = (signal: "pq" | "hlg", mastering: Colour["mastering"]): Colour => ({
  signal,
  transfer: signal === "pq" ? "smpte2084" : "arib-std-b67",
  primaries: "bt2020",
  matrix: "bt2020nc",
  range: "limited",
  mastering,
});

const sdr = (codec: string, pixelFormat: string, depth: number): SourceVideo => ({
  codec,
  pixelFormat,
  depth,
  colour: SDR_BT709,
  scan: "progressive",
  ...SIZE,
});

const libx265 = (pixelFormat: string, params = "log-level=error"): ReadonlyArray<string> => [
  "-c:v",
  "libx265",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  pixelFormat,
  "-x265-params",
  params,
];

/** Every clip, by name. */
export const PROBE_CLIPS: Readonly<Record<ClipName, ProbeClip>> = {
  "h264-8": {
    source: sdr("h264", "yuv420p", 8),
    needs: "encoder:libx264",
    args: [...PICTURE, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
  },
  "h264-10": {
    source: sdr("h264", "yuv420p10le", 10),
    needs: "encoder:libx264",
    args: [...PICTURE, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le"],
  },
  "hevc-8": {
    source: sdr("hevc", "yuv420p", 8),
    needs: "encoder:libx265",
    args: [...PICTURE, ...libx265("yuv420p")],
  },
  "hevc-10": {
    source: sdr("hevc", "yuv420p10le", 10),
    needs: "encoder:libx265",
    args: [...PICTURE, ...libx265("yuv420p10le")],
  },
  "hevc-pq": {
    source: { ...sdr("hevc", "yuv420p10le", 10), colour: hdr("pq", "present") },
    needs: "encoder:libx265",
    args: [
      ...PICTURE,
      "-vf",
      PQ,
      ...libx265("yuv420p10le", HDR10_X265),
      "-color_primaries",
      "bt2020",
      "-color_trc",
      "smpte2084",
      "-colorspace",
      "bt2020nc",
    ],
  },
  "hevc-hlg": {
    source: { ...sdr("hevc", "yuv420p10le", 10), colour: hdr("hlg", "absent") },
    needs: "encoder:libx265",
    args: [
      ...PICTURE,
      "-vf",
      HLG,
      ...libx265("yuv420p10le"),
      "-color_primaries",
      "bt2020",
      "-color_trc",
      "arib-std-b67",
      "-colorspace",
      "bt2020nc",
    ],
  },
  "av1-8": {
    source: sdr("av1", "yuv420p", 8),
    needs: "encoder:libsvtav1",
    args: [...PICTURE, "-c:v", "libsvtav1", "-preset", "12", "-pix_fmt", "yuv420p"],
  },
  "av1-10": {
    source: sdr("av1", "yuv420p10le", 10),
    needs: "encoder:libsvtav1",
    args: [...PICTURE, "-c:v", "libsvtav1", "-preset", "12", "-pix_fmt", "yuv420p10le"],
  },
  "vp9-8": {
    source: sdr("vp9", "yuv420p", 8),
    needs: "encoder:libvpx-vp9",
    args: [
      ...PICTURE,
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-pix_fmt",
      "yuv420p",
    ],
  },
  "vp9-10": {
    source: sdr("vp9", "yuv420p10le", 10),
    needs: "encoder:libvpx-vp9",
    args: [
      ...PICTURE,
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-pix_fmt",
      "yuv420p10le",
    ],
  },
  "mpeg2-8": {
    source: sdr("mpeg2video", "yuv420p", 8),
    needs: "encoder:mpeg2video",
    args: [...PICTURE, "-c:v", "mpeg2video", "-pix_fmt", "yuv420p"],
  },
  "mpeg2-8-interlaced": {
    source: { ...sdr("mpeg2video", "yuv420p", 8), scan: "interlaced" },
    needs: "encoder:mpeg2video",
    args: [...WOVEN, "-c:v", "mpeg2video", "-pix_fmt", "yuv420p"],
  },
  "h264-10-interlaced": {
    source: { ...sdr("h264", "yuv420p10le", 10), scan: "interlaced" },
    needs: "encoder:libx264",
    args: [...WOVEN, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le"],
  },
  "h264-8-gray": {
    source: sdr("h264", "yuv420p", 8),
    needs: "encoder:libx264",
    args: [
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:size=320x240:rate=10:duration=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
    ],
  },
};

/**
 * The image subtitle an overlay's probe reads, in BGRA with straight alpha, as ffmpeg hands image
 * subtitles to filters: three upright bands, clear, opaque white, and white at half opacity.
 */
export const PROBE_CANVAS = [
  "color=c=black@0:size=320x240:rate=10:duration=1",
  "format=bgra",
  "drawbox=x=107:y=0:w=106:h=240:color=white@1:thickness=fill:replace=1",
  "drawbox=x=213:y=0:w=107:h=240:color=white@0.5:thickness=fill:replace=1",
].join(",");

/**
 * The ASS script a text row's probe draws: one full block (U+2588) in the default font, white,
 * 96 lines tall, centred on the 320x240 picture. No font with the glyph draws nothing there.
 */
export const PROBE_SCRIPT = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 320",
  "PlayResY: 240",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,DejaVu Sans,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\\pos(160,120)}\u2588",
  "",
].join("\n");

/** The mean of the 8-bit gray picture `gray`, 320 wide, over columns and rows from `x0`, `y0`. */
const meanOf = (gray: Uint8Array, x0: number, x1: number, y0: number, y1: number): number => {
  let total = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      total += gray[y * 320 + x] ?? 0;
      count += 1;
    }
  }

  return count === 0 ? 0 : total / count;
};

/** A measured level, rounded for the evidence. */
const level = (value: number): string => value.toFixed(0);

/** How far the gray clip, decoded, may lie from the middle gray `color=c=gray` draws. */
const GRAY = { low: 110, high: 146 } as const;

/** What a probe's picture read back showed, and whether it shows the subtitle drawn as it must. */
export interface ReadbackVerdict {
  readonly passed: boolean;
  /** The measured levels, for the evidence. */
  readonly detail: string;
}

/**
 * Whether the 320x240 gray picture a subtitle row's probe read back (`gray`, 8 bits a pixel) shows
 * `readback`, measured inside each region with a margin to its edges. `blend`: the clear band keeps
 * the clip's gray, the opaque band is white (220 or more), and the half band lies within 14 levels
 * of halfway between them, so an overlay that ignores alpha, takes it as premultiplied, or draws
 * nothing fails. `glyph`: the block's middle is white (215 or more) and the left edge, which no
 * glyph reaches, keeps the clip's gray.
 */
export const readbackVerdict = (readback: Readback, gray: Uint8Array): ReadbackVerdict => {
  if (gray.length < 320 * 240) {
    return {
      passed: false,
      detail: `read back ${String(gray.length)} bytes, not a 320x240 picture`,
    };
  }

  if (readback === "blend") {
    const clear = meanOf(gray, 8, 99, 8, 232);
    const opaque = meanOf(gray, 115, 206, 8, 232);
    const half = meanOf(gray, 221, 312, 8, 232);
    const expected = (clear + opaque) / 2;

    return {
      passed:
        clear >= GRAY.low && clear <= GRAY.high && opaque >= 220 && Math.abs(half - expected) <= 14,
      detail: `clear ${level(clear)}, opaque ${level(opaque)}, half ${level(half)} (expected ${level(expected)})`,
    };
  }

  const glyph = meanOf(gray, 150, 170, 110, 130);
  const edge = meanOf(gray, 0, 60, 0, 240);

  return {
    passed: glyph >= 215 && edge >= GRAY.low && edge <= GRAY.high,
    detail: `glyph ${level(glyph)}, edge ${level(edge)}`,
  };
};

/** The clips a decoder row tries, one per codec and layout. */
export const DECODE_CLIPS: ReadonlyArray<ClipName> = [
  "h264-8",
  "h264-10",
  "hevc-8",
  "hevc-10",
  "av1-8",
  "av1-10",
  "vp9-8",
  "vp9-10",
  "mpeg2-8",
];
