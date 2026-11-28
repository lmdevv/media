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
 * The patches the HDR clips are made of, R'G'B' codes in four columns of 80 by two rows of 120:
 * black, gray 128, white, and gray 64 above, red, green, and blue at 192 and gray 192 below, coded as
 * PQ or HLG as they stand. A tone map keeps the grays neutral and in order and each primary its
 * own hue, which a picture of the wrong chroma, or of none, does not (`readbackVerdict`).
 */
const PATCH_COLOURS = [
  ["0x000000", "0x808080", "0xffffff", "0x404040"],
  ["0xc00000", "0x00c000", "0x0000c0", "0xc0c0c0"],
] as const;

const PATCHES = [
  "-f",
  "lavfi",
  "-i",
  [
    "color=c=0x808080:size=320x240:rate=10:duration=1",
    ...PATCH_COLOURS.flatMap((row, y) =>
      row.map(
        (colour, x) =>
          `drawbox=x=${String(x * 80)}:y=${String(y * 120)}:w=80:h=120:color=${colour}:t=fill`,
      ),
    ),
  ].join(","),
];

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
      ...PATCHES,
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
  "hevc-pq-bare": {
    source: { ...sdr("hevc", "yuv420p10le", 10), colour: hdr("pq", "absent") },
    needs: "encoder:libx265",
    args: [
      ...PATCHES,
      "-vf",
      PQ,
      ...libx265("yuv420p10le"),
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
      ...PATCHES,
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

/** The layout a probe reads `readback` back in: R'G'B' where colour is judged, else gray. */
export const readbackPixelFormat = (readback: Readback): "gray" | "rgb24" =>
  readback === "picture" ? "rgb24" : "gray";

/** The mean R'G'B' of the middle of the patch in column `x` and row `y` of a 320x240 rgb24 picture. */
const patchOf = (rgb: Uint8Array, x: number, y: number): readonly [number, number, number] => {
  const total = [0, 0, 0];
  let count = 0;

  for (let row = y * 120 + 30; row < y * 120 + 90; row += 1) {
    for (let column = x * 80 + 20; column < x * 80 + 60; column += 1) {
      for (const channel of [0, 1, 2] as const) {
        total[channel] = (total[channel] ?? 0) + (rgb[(row * 320 + column) * 3 + channel] ?? 0);
      }

      count += 1;
    }
  }

  return [(total[0] ?? 0) / count, (total[1] ?? 0) / count, (total[2] ?? 0) / count];
};

const lumaOf = ([r, g, b]: readonly [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A measured colour, rounded for the evidence. */
const shown = (colour: readonly [number, number, number]): string => colour.map(level).join(",");

/**
 * How a tone map's picture of the HDR clips' patches must come out: each gray's channels within
 * `neutral` of each other, black, gray 64, and gray 128 at least `steps` apart in luma, and each
 * primary at least `primary` above the other two channels. On ffmpeg 9 the CPU's Hable and
 * libplacebo's BT.2390 keep the grays within 1, step them 47 to 122 apart, and lift each primary
 * 141 or more above the rest; solid green with the luma's shadows, or a gray picture, fails.
 */
const MAPPED = { neutral: 12, steps: 20, primary: 60 } as const;

/** How far the gray clip, decoded, may lie from the middle gray `color=c=gray` draws. */
const GRAY = { low: 110, high: 146 } as const;

/** What a probe's picture read back showed, and whether it shows the subtitle drawn as it must. */
export interface ReadbackVerdict {
  readonly passed: boolean;
  /** The measured levels, for the evidence. */
  readonly detail: string;
}

/** Whether a tone map's rgb24 picture of the HDR clips keeps their patches (`MAPPED`). */
const pictureVerdict = (rgb: Uint8Array): ReadbackVerdict => {
  const grays = [patchOf(rgb, 0, 0), patchOf(rgb, 3, 0), patchOf(rgb, 1, 0), patchOf(rgb, 3, 1)];
  const primaries = [patchOf(rgb, 0, 1), patchOf(rgb, 1, 1), patchOf(rgb, 2, 1)];
  const neutral = grays.every((gray) => Math.max(...gray) - Math.min(...gray) <= MAPPED.neutral);
  const [black = 0, dark = 0, middle = 0] = grays.map(lumaOf);
  const stepped = dark - black >= MAPPED.steps && middle - dark >= MAPPED.steps;

  const hued = primaries.every(
    (colour, channel) =>
      (colour[channel] ?? 0) - Math.max(...colour.filter((_, other) => other !== channel)) >=
      MAPPED.primary,
  );

  return {
    passed: neutral && stepped && hued,
    detail: `grays ${grays.map(shown).join(" ")}; red, green, blue ${primaries.map(shown).join(" ")}`,
  };
};

/**
 * Whether the 320x240 picture a probe read back shows `readback`, measured inside each region with a
 * margin to its edges: in 8-bit gray, or in 8-bit R'G'B' for `picture` (`readbackPixelFormat`).
 * `blend`: the clear band keeps the clip's gray, the opaque band is white (220 or more), and the
 * half band lies within 14 levels of halfway between them, so an overlay that ignores alpha, takes
 * it as premultiplied, or draws nothing fails. `glyph`: the block's middle is white (215 or more)
 * and the left edge, which no glyph reaches, keeps the clip's gray. `picture`: a tone map's frames
 * keep the HDR clip's patches (`MAPPED`), so one that hands on blank frames, or frames of the wrong
 * chroma or of none, fails.
 */
export const readbackVerdict = (readback: Readback, picture: Uint8Array): ReadbackVerdict => {
  const size = 320 * 240 * (readbackPixelFormat(readback) === "rgb24" ? 3 : 1);

  if (picture.length < size) {
    return {
      passed: false,
      detail: `read back ${String(picture.length)} bytes, not a 320x240 picture`,
    };
  }

  if (readback === "picture") return pictureVerdict(picture);

  if (readback === "blend") {
    const clear = meanOf(picture, 8, 99, 8, 232);
    const opaque = meanOf(picture, 115, 206, 8, 232);
    const half = meanOf(picture, 221, 312, 8, 232);
    const expected = (clear + opaque) / 2;

    return {
      passed:
        clear >= GRAY.low && clear <= GRAY.high && opaque >= 220 && Math.abs(half - expected) <= 14,
      detail: `clear ${level(clear)}, opaque ${level(opaque)}, half ${level(half)} (expected ${level(expected)})`,
    };
  }

  const glyph = meanOf(picture, 150, 170, 110, 130);
  const edge = meanOf(picture, 0, 60, 0, 240);

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
