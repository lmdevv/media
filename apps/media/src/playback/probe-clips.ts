/**
 * The generated clips capability probes read: ten frames at 320x240, one per codec and layout a
 * decoder row tries, plus HDR clips for tone maps and interlaced clips for deinterlacers. The
 * service writes each once with software encoders; a clip this build cannot make proves nothing,
 * and the keys that need it wait for a real source.
 */
import type { BuildFeature, ClipName, SourceVideo } from "./video-ops.ts";

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

const sdr = (codec: string, pixelFormat: string, depth: number): SourceVideo => ({
  codec,
  pixelFormat,
  depth,
  colour: "sdr",
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
    source: { ...sdr("hevc", "yuv420p10le", 10), colour: "hdr10" },
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
    source: { ...sdr("hevc", "yuv420p10le", 10), colour: "hlg" },
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
