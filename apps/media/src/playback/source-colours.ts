/**
 * What the transcoder does with each kind of source colour, as one table (`COLOUR_DECISIONS`) that
 * its test prints: whether the original may be copied and what a client must declare for it (the
 * shared direct-play check, `playableAs`), what a copy keeps of a Dolby Vision configuration, the
 * signal its decoded frames carry, which picks the tone map, and how an encode reaches SDR. The
 * rows read the signal; nothing else branches on a kind of source.
 */
import { canonicalCodec, dolbyVisionBase, playableAs } from "@media/contracts/direct-play";
import type { DynamicRange } from "@media/contracts/media-playback";

import type { VideoStream } from "../media/media-probe.ts";
import type { Colour, Signal } from "./video-ops.ts";

/** Each kind of source colour the table decides for, in the table's order. */
export const SOURCE_KINDS = [
  "sdr",
  "sdr-bt601",
  "sdr-bt2020",
  "sdr-full-range",
  "hdr10",
  "hdr10plus",
  "hlg",
  "dolby-vision-5",
  "dolby-vision-7",
  "dolby-vision-8.1",
  "dolby-vision-8.2",
  "dolby-vision-8.4",
  "dolby-vision-other",
] as const;

/** A kind of source colour. */
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What the transcoder does with one kind of source. */
export interface ColourDecision {
  /** The source, in words. */
  readonly about: string;
  /**
   * A stream of this kind, as the probe reads it, from which the table's direct-play and copy rules
   * are printed.
   */
  readonly example: Pick<VideoStream, "codec" | "dynamicRange" | "dolbyVision" | "dolbyVisionRpu">;
  /**
   * What a copy (remux) for a client that declares Dolby Vision keeps of the stream's Dolby Vision
   * configuration: `kept` writes it into the output, so the player applies the RPU; `dropped`
   * sends the base layer as a plain stream; `none` for a stream without one.
   */
  readonly dolbyVisionCopy: "kept" | "dropped" | "none";
  /** What its decoded frames carry, which picks the tone map, if any. */
  readonly signal: Signal;
  /** How an encode reaches 8-bit SDR BT.709. */
  readonly encode: string;
  /** Why this is the right answer. */
  readonly why: string;
}

const SDR = { codec: "hevc", dynamicRange: "sdr" } as const;

/** What keeps an SDR source's own colour on Quick Sync's path, whose scale would convert it. */
const QSV_KEEPS =
  "Quick Sync's scale is told to output the source's colour, which it would otherwise convert under the source's tags";

/**
 * How HDR reaches SDR: libplacebo's BT.2390 on Quick Sync's and VA-API's paths where Vulkan is
 * proven, the reference the table is judged against; else the GPU's own tone map, which renders
 * shadows and mid-tones darker; zscale and Hable on the CPU.
 */
const GPU_TONE_MAP =
  "mapped to SDR BT.709 by libplacebo (BT.2390) on Quick Sync's or VA-API's path where Vulkan is proven and it keeps up at the output's size, else by the GPU's own tone map (darker in the shadows and mid-tones), and by zscale with Hable on the CPU";

/** The table: one decision per kind of source. */
export const COLOUR_DECISIONS: Readonly<Record<SourceKind, ColourDecision>> = {
  sdr: {
    about: "SDR BT.709 (or untagged), limited range",
    example: SDR,
    dolbyVisionCopy: "none",
    signal: "sdr",
    encode: "scaled and encoded; no colour conversion",
    why: "every client plays SDR; the chain is the one main runs, argument for argument",
  },
  "sdr-bt601": {
    about: "SDR BT.601 (smpte170m, bt470bg), as SD video is",
    example: SDR,
    dolbyVisionCopy: "none",
    signal: "sdr",
    encode: `scaled and encoded in its own matrix and primaries; ${QSV_KEEPS}`,
    why: "BT.601 is SD's own colour and every client reads its tags; converting would change nothing a viewer sees",
  },
  "sdr-bt2020": {
    about: "SDR with BT.2020 primaries or matrix",
    example: SDR,
    dolbyVisionCopy: "none",
    signal: "sdr",
    encode: `scaled and encoded in BT.2020; ${QSV_KEEPS}`,
    why: "its transfer is SDR's, so nothing is tone-mapped; the tags say how to show it",
  },
  "sdr-full-range": {
    about: "SDR in full range (pc, yuvj)",
    example: SDR,
    dolbyVisionCopy: "none",
    signal: "sdr",
    encode: `scaled and encoded in full range; ${QSV_KEEPS}`,
    why: "full range is legal in H.264, HEVC, and AV1, and players read the range flag",
  },
  hdr10: {
    about: "HDR10: PQ, BT.2020",
    example: { codec: "hevc", dynamicRange: "hdr10" },
    dolbyVisionCopy: "none",
    signal: "pq",
    encode: GPU_TONE_MAP,
    why: "a client that declares HDR10 plays it; any other needs SDR",
  },
  hdr10plus: {
    about: "HDR10+: HDR10 with SMPTE 2094-40 dynamic metadata",
    example: { codec: "hevc", dynamicRange: "hdr10" },
    dolbyVisionCopy: "none",
    signal: "pq",
    encode:
      "as HDR10, from its static metadata: its dynamic metadata is removed before every tone map, so no path reads it, and none is kept",
    why: "its base is ordinary HDR10, which every HDR10 player shows",
  },
  hlg: {
    about: "HLG: ARIB STD-B67, BT.2020",
    example: { codec: "hevc", dynamicRange: "hlg" },
    dolbyVisionCopy: "none",
    signal: "hlg",
    encode: `${GPU_TONE_MAP}; VA-API's own needs mastering display metadata HLG has none of, so without libplacebo its chains map on the CPU`,
    why: "a client that declares HLG plays it; any other needs SDR",
  },
  "dolby-vision-5": {
    about:
      "Dolby Vision 5: IPT-PQ-c2, no compatible base layer, whatever its compatibility id says",
    example: {
      codec: "hevc",
      dynamicRange: "dolby-vision",
      dolbyVision: { profile: 5, level: 6, compatibility: 0 },
      dolbyVisionRpu: true,
    },
    dolbyVisionCopy: "kept",
    signal: "dovi",
    encode:
      "reshaped by its RPU and mapped by libplacebo on Quick Sync's and VA-API's paths where Vulkan is proven, at any size, when its first picture carries an RPU; refused otherwise, on the CPU's, and elsewhere (dolby-vision-not-convertible)",
    why: "read as HDR10 its IPT samples come out green and purple, so no PQ tone map may take it, and without its RPU nothing says what they mean",
  },
  "dolby-vision-7": {
    about: "Dolby Vision 7: HDR10 base layer with an enhancement layer",
    example: {
      codec: "hevc",
      dynamicRange: "dolby-vision",
      dolbyVision: { profile: 7, level: 6, compatibility: 6 },
    },
    dolbyVisionCopy: "dropped",
    signal: "pq",
    encode: "its HDR10 base layer tone-mapped as HDR10; the enhancement layer and RPU are not read",
    why: "players other than Blu-ray's do not apply profile 7 (AVFoundation fails to decode it with its record, so the original never plays as stored), and every HDR10 player shows its base layer",
  },
  "dolby-vision-8.1": {
    about: "Dolby Vision 8.1: HDR10 base layer",
    example: {
      codec: "hevc",
      dynamicRange: "dolby-vision",
      dolbyVision: { profile: 8, level: 6, compatibility: 1 },
    },
    dolbyVisionCopy: "kept",
    signal: "pq",
    encode: "its HDR10 base layer tone-mapped as HDR10",
    why: "the base layer is ordinary HDR10, the picture a player without Dolby Vision shows",
  },
  "dolby-vision-8.2": {
    about: "Dolby Vision 8.2: SDR base layer",
    example: {
      codec: "hevc",
      dynamicRange: "dolby-vision",
      dolbyVision: { profile: 8, level: 6, compatibility: 2 },
    },
    dolbyVisionCopy: "kept",
    signal: "sdr",
    encode: "its SDR base layer scaled and encoded; nothing is tone-mapped",
    why: "the base layer is SDR, which every client plays",
  },
  "dolby-vision-8.4": {
    about: "Dolby Vision 8.4: HLG base layer, as iPhones record",
    example: {
      codec: "hevc",
      dynamicRange: "dolby-vision",
      dolbyVision: { profile: 8, level: 4, compatibility: 4 },
    },
    dolbyVisionCopy: "kept",
    signal: "hlg",
    encode: "its HLG base layer tone-mapped as HLG",
    why: "the base layer is ordinary HLG, the picture a player without Dolby Vision shows",
  },
  "dolby-vision-other": {
    about:
      "Dolby Vision of another profile, a profile and compatibility id that disagree, another codec, or an RPU with no configuration record",
    example: { codec: "hevc", dynamicRange: "dolby-vision", dolbyVisionRpu: true },
    dolbyVisionCopy: "none",
    signal: "dovi",
    encode:
      "as Dolby Vision 5: libplacebo, which reads the RPU, when the first picture has one; else refused",
    why: "without a base layer the table names, only the RPU says what the samples mean, and no player is known to take the original",
  },
};

/** The Dolby Vision 8 kinds, by what the shared check reads their base layer as. */
const PROFILE_8: ReadonlyMap<DynamicRange, SourceKind> = new Map([
  ["hdr10", "dolby-vision-8.1"],
  ["sdr", "dolby-vision-8.2"],
  ["hlg", "dolby-vision-8.4"],
]);

/** ffprobe's names for BT.601's primaries and matrix. */
const BT601: ReadonlySet<string> = new Set(["smpte170m", "bt470bg", "bt470m", "smpte240m"]);

/** ffprobe's names for BT.2020's primaries and matrices. */
const BT2020: ReadonlySet<string> = new Set(["bt2020", "bt2020nc", "bt2020c"]);

/** Whether `video` is in full range: its range says so, or its layout is a JPEG one. */
const fullRange = (video: VideoStream): boolean =>
  video.colour?.range === "full" || (video.pixelFormat ?? "").startsWith("yuvj");

/** The kind of `video`'s colour, as the probe read it. */
export const kindOf = (video: VideoStream): SourceKind => {
  if (video.dynamicRange === "dolby-vision") {
    const profile = video.dolbyVision?.profile;

    if (profile === 5 && canonicalCodec(video.codec) === "hevc") return "dolby-vision-5";
    const base = dolbyVisionBase(video);

    if (base === undefined) return "dolby-vision-other";

    return profile === 7 ? "dolby-vision-7" : (PROFILE_8.get(base) ?? "dolby-vision-other");
  }

  if (video.dynamicRange === "hdr10") return video.hdr10Plus === true ? "hdr10plus" : "hdr10";

  if (video.dynamicRange === "hlg") return "hlg";

  if (fullRange(video)) return "sdr-full-range";
  const tags = [video.colour?.primaries, video.colour?.matrix];

  if (tags.some((tag) => tag !== undefined && BT2020.has(tag))) return "sdr-bt2020";

  return tags.some((tag) => tag !== undefined && BT601.has(tag)) ? "sdr-bt601" : "sdr";
};

/** The decision for `video`'s kind of colour. */
const decisionOf = (video: VideoStream): ColourDecision => COLOUR_DECISIONS[kindOf(video)];

/**
 * Whether an encode can show `video` right: every kind but Dolby Vision that only its RPU explains
 * (`dovi`: profile 5 and the kinds the table does not name), which needs the RPU in its first
 * picture.
 */
export const convertible = (video: VideoStream): boolean =>
  decisionOf(video).signal !== "dovi" || video.dolbyVisionRpu === true;

/** The colour `video`'s decoded frames are in, as rows read it. */
export const sourceColour = (video: VideoStream): Colour => ({
  signal: decisionOf(video).signal,
  transfer: video.colour?.transfer,
  primaries: video.colour?.primaries,
  matrix: video.colour?.matrix,
  range: fullRange(video) ? "full" : "limited",
  mastering: video.colour?.mastering === undefined ? "absent" : "present",
});

/** One line of the printed table. */
export interface TableLine {
  readonly kind: SourceKind;
  readonly about: string;
  /** The dynamic ranges a client may declare, any one of which lets it play the original file. */
  readonly directPlayTo: string;
  /** The dynamic ranges a client may declare, any one of which lets it receive a copy (remux). */
  readonly copiedTo: string;
  readonly dolbyVisionCopy: ColourDecision["dolbyVisionCopy"];
  readonly signal: Signal;
  readonly encode: string;
  readonly why: string;
}

/** The table as lines, in its order, with each kind's direct-play and copy rules from the shared check. */
export const tableLines = (): ReadonlyArray<TableLine> =>
  SOURCE_KINDS.map((kind) => {
    const decision = COLOUR_DECISIONS[kind];

    return {
      kind,
      about: decision.about,
      directPlayTo: playableAs(decision.example, "stored").join(" or "),
      copiedTo: playableAs(decision.example, "copied").join(" or "),
      dolbyVisionCopy: decision.dolbyVisionCopy,
      signal: decision.signal,
      encode: decision.encode,
      why: decision.why,
    };
  });
