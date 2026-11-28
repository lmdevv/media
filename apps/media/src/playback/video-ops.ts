/**
 * The vocabulary of the transcoder's operation table. A row is one way to do one video operation
 * in one frame memory (`decode.qsv`, `tonemap.cpu`, `move.cpu>vaapi`): it says which frames it
 * takes, which it emits, the ffmpeg text it renders, and the generated clips that prove it. Rows
 * read and write `Frame` and nothing else, and accept by closed lists, so widening a union never
 * widens an old row. `video-pipeline.ts` joins rows into pipelines; the rows live in
 * `video-ops-cpu.ts` and `video-ops-intel.ts`, one file per backend.
 */
import type { DynamicRange } from "@media/contracts/media-playback";
import { Brand, Data } from "effect";

import type * as MediaConfig from "../media-config.ts";

/** Where frames live: CPU memory or one GPU API's surfaces. A backend adds a member. */
export type Domain = "cpu" | "qsv" | "vaapi";

/** A domain whose frames live on a device. */
export type GpuDomain = Exclude<Domain, "cpu">;

/** What the transcoder encodes to. */
export type OutputCodec = "h264" | "hevc" | "av1";

/** Every codec the transcoder encodes to. */
export const OUTPUT_CODECS: ReadonlyArray<OutputCodec> = ["h264", "hevc", "av1"];

/**
 * The share of H.264's bitrate an encode in each codec gets for the same picture. HEVC and AV1
 * need fewer bits for the same quality; these shares are conservative, keeping more bits than the
 * savings usually quoted (about a half for HEVC, more for AV1), until measured quality says more.
 */
export const BITRATE_SHARE: Readonly<Record<OutputCodec, number>> = {
  h264: 1,
  hevc: 0.75,
  av1: 0.65,
};

/**
 * One stream an encode may produce, as the decision asks for it and encode rows read it. Rows take
 * the codec, depth, and colour as data and accept only the entries they register: 8-bit SDR.
 */
export interface OutputTarget {
  readonly codec: OutputCodec;
  /** Bits per component of the encoded picture. */
  readonly depth: number;
  readonly colour: DynamicRange;
  /** Whether an encoder on the CPU may produce it, or only one on a GPU. */
  readonly cpuEncode: "allowed" | "refused";
  /**
   * The highest level the client declared for the codec, in ffprobe's units, which the encode's
   * picture, frame rate, and bitrate must fit (`output-levels.ts`); none limits nothing.
   */
  readonly level: number | undefined;
}

/**
 * What a frame's samples encode: `sdr`; `pq`, HDR10's transfer, which HDR10+ and the base layer of
 * Dolby Vision 7 and 8.1 share; `hlg`, which Dolby Vision 8.4's base layer shares; or `dovi`, the
 * IPT-PQ-c2 of Dolby Vision 5, which only the stream's RPU, read picture by picture, reshapes into
 * colour.
 */
export type Signal = "sdr" | "pq" | "hlg" | "dovi";

/** The colour a frame's samples are in, as rows read and write it. */
export interface Colour {
  readonly signal: Signal;
  /** The transfer, as ffprobe names it (`bt709`, `smpte170m`, `smpte2084`); none when unstated. */
  readonly transfer: string | undefined;
  /** The primaries, as ffprobe names them (`bt709`, `bt2020`, `smpte170m`); none when unstated. */
  readonly primaries: string | undefined;
  /** The matrix, as ffprobe's `color_space` names it (`bt709`, `bt2020nc`); none when unstated. */
  readonly matrix: string | undefined;
  readonly range: "limited" | "full";
  /** Whether the frames carry mastering display metadata, which VA-API's tone map reads. */
  readonly mastering: "present" | "absent";
}

/**
 * SDR BT.709 in limited range with no HDR metadata: the colour every tone map's frames leave in,
 * and every SDR target's.
 */
export const SDR_BT709: Colour = {
  signal: "sdr",
  transfer: "bt709",
  primaries: "bt709",
  matrix: "bt709",
  range: "limited",
  mastering: "absent",
};

const RANGE_OF_SIGNAL: Readonly<Record<Signal, DynamicRange>> = {
  sdr: "sdr",
  pq: "hdr10",
  hlg: "hlg",
  dovi: "dolby-vision",
};

/** The dynamic range the wire names frames of `colour` by. */
export const dynamicRangeOf = (colour: Colour): DynamicRange => RANGE_OF_SIGNAL[colour.signal];

/**
 * Whether a chain from a source of `colour` to `target` maps HDR to SDR: the target is SDR and the
 * source is not. Each target says it for itself, so one intent may offer an HDR source as HDR to
 * one target and tone-mapped to the next.
 */
export const toneMapsTo = (colour: Colour, target: OutputTarget): boolean =>
  colour.signal !== "sdr" && target.colour === "sdr";

/** `codec` at 8-bit SDR, from any encoder and at any size: what probes encode. */
export const sdrTarget = (codec: OutputCodec): OutputTarget => ({
  codec,
  depth: 8,
  colour: "sdr",
  cpuEncode: "allowed",
  level: undefined,
});

/** Whether a frame holds a whole picture or two fields. */
export type Scan = "progressive" | "interlaced";

/** What a frame is at one point of a chain. */
export interface Frame {
  /** Which kind of memory holds it. */
  readonly memory: Domain;
  /** The render node of the device that holds it; none in CPU memory. */
  readonly device: string | undefined;
  readonly colour: Colour;
  /** Bits per component: 8, 10, or 12. */
  readonly depth: number;
  /** The exact layout, such as `yuv420p`, `yuv420p10le`, or, on a GPU, `nv12` and `p010le`. */
  readonly pixelFormat: string;
  readonly scan: Scan;
  readonly width: number;
  readonly height: number;
}

/** A video stream as rows see it before anything decodes it. */
export interface SourceVideo extends Omit<Frame, "memory" | "device"> {
  /** ffprobe's codec name, such as `h264` or `mpeg2video`. */
  readonly codec: string;
}

/** An image subtitle drawn onto the picture, read as frames of its own. */
export interface SubtitleInput {
  /** The ffmpeg input it is read from. */
  readonly input: number;
  /** Its stream index within that input. */
  readonly stream: number;
  /** ffprobe's codec name, such as `dvd_subtitle`. */
  readonly codec: string;
  /** Where its frames are and what canvas they cover. */
  readonly frame: Frame;
}

/**
 * A text subtitle libass draws into the picture. libass reads it from an ASS file each run names
 * (`RunFile`), on the source's timeline, beside the fonts the media file carries.
 */
export interface TextSubtitle {
  /** ffprobe's codec name or the sidecar's format, such as `ass`, `subrip`, or `srt`. */
  readonly codec: string;
  /**
   * `styled` keeps the track's own styles, positions, effects, and fonts (ASS and SSA); `plain`
   * text is drawn in the service's one default style.
   */
  readonly style: "styled" | "plain";
  /**
   * The source picture's size, which libass takes as the size the script was made for, so
   * borders, shadows, and blur a script does not scale with its own resolution keep their share
   * of a scaled picture.
   */
  readonly storage: { readonly width: number; readonly height: number };
}

/** One video operation. */
export type Op = Data.TaggedEnum<{
  Decode: { readonly codec: string };
  /**
   * Two fields to one picture, one frame for each frame at the source's rate. Frames the decoder
   * flags progressive pass through untouched, and each frame's own flag says which field is first.
   */
  Deinterlace: {};
  /** `depth` is the bit depth the scaled frames leave in. */
  Scale: { readonly width: number; readonly height: number; readonly depth: number };
  /** HDR to SDR. */
  ToneMap: {};
  BurnImage: { readonly subtitle: SubtitleInput };
  BurnText: { readonly subtitle: TextSubtitle };
  /**
   * `bitrate` is the target's: a cap on the CPU, the rate on a GPU. `level` is the level the
   * stream states, in ffprobe's units; none leaves it to the encoder.
   */
  Encode: {
    readonly target: OutputTarget;
    readonly bitrate: number;
    readonly level: number | undefined;
  };
  /** Only `assemble` creates moves. */
  Move: { readonly to: Domain };
}>;

/** Constructors and matchers for `Op`. */
export const Op = Data.taggedEnum<Op>();

/** The name of an operation. */
export type OpName = Op["_tag"];

/** An operation that draws a subtitle into the picture: an image subtitle's or a text track's. */
export type Burn = Extract<Op, { readonly _tag: "BurnImage" | "BurnText" }>;

/** The operation named `T`. */
type OpOf<T extends OpName> = Extract<Op, { readonly _tag: T }>;

/** A row's identity, such as `decode.qsv` or `move.cpu>vaapi`. */
export type ImplId = string & Brand.Brand<"ImplId">;

/** Brands a row's identity. */
export const ImplId = Brand.nominal<ImplId>();

/**
 * `${ImplId}:${variant}`, such as `decode.qsv:hevc/yuv420p10le` or `scale.vaapi:10>8`: one thing a
 * row may be asked to do, and the unit evidence is kept for.
 */
export type CapabilityKey = string & Brand.Brand<"CapabilityKey">;

const capabilityKeyOf = Brand.nominal<CapabilityKey>();

/** The key of `impl` doing `variant`. */
export const capabilityKey = (impl: ImplId, variant: string): CapabilityKey =>
  capabilityKeyOf(`${impl}:${variant}`);

/** The row a key belongs to. */
export const implOf = (key: CapabilityKey): ImplId => ImplId(key.slice(0, key.indexOf(":")));

/**
 * A component of the ffmpeg build a row cannot run without: an encoder, a decoder, a filter, a
 * hardware acceleration method, or a codec ffmpeg can decode in software.
 */
export type BuildFeature =
  | `encoder:${string}`
  | `decoder:${string}`
  | `filter:${string}`
  | `hwaccel:${string}`
  | `decodes:${string}`
  | `option:${string}`;

/** The build feature of libplacebo's `shader_cache` option, which ffmpeg 7.1's filter lacks. */
export const SHADER_CACHE_OPTION: BuildFeature = "option:libplacebo:shader_cache";

/**
 * Where libplacebo keeps the shaders it compiles, under the data folder (`RunFile` `shaders`): a
 * start that finds them saves their compiling, about 0.12 s of a first picture on the Arc A380.
 */
const SHADER_CACHE = "libplacebo-shaders.cache";

/**
 * The run files that name libplacebo's shader cache (`SHADER_CACHE`) under `dataDir`, for a build
 * whose `features` have the option (`SHADER_CACHE_OPTION`); none for one without.
 */
export const shaderCacheFiles = (
  features: ReadonlySet<BuildFeature> | undefined,
  dataDir: string,
): { readonly shaders?: string } =>
  features?.has(SHADER_CACHE_OPTION) === true ? { shaders: `${dataDir}/${SHADER_CACHE}` } : {};

/**
 * A file each run names for itself that a filter reads: a text subtitle as ASS, its fonts, and
 * libplacebo's shader cache.
 */
export type RunFile = "subtitle" | "fonts" | "shaders";

/**
 * A named option's value: text, or the path of a file the run names (`RenderOptions.files`). The
 * renderer escapes every value as it writes it; an option whose file the run does not name is
 * left out.
 */
export type OptionValue = string | { readonly file: RunFile };

/** One filter of a graph, rendered as `name=arg:key=value`. */
export interface FilterCall {
  readonly name: string;
  /** Positional values and named options, in order. */
  readonly args: ReadonlyArray<string | readonly [string, OptionValue]>;
  /**
   * Adjacent calls of one filter that both fuse become one call: their named options merge, and a
   * later option of the same name takes the earlier one's place.
   */
  readonly fuses?: true;
}

/** A filter call: `filter("scale", "1920", "1080", ["flags", "bicubic"])`. */
export const filter = (name: string, ...args: FilterCall["args"]): FilterCall => ({ name, args });

/** A filter call that fuses with an adjacent call of the same filter. */
export const fusing = (name: string, ...args: FilterCall["args"]): FilterCall => ({
  name,
  args,
  fuses: true,
});

/** Filters a second input runs through before a row joins it, such as an overlay's subtitle. */
interface SideFilters {
  readonly input: number;
  readonly stream: number;
  readonly calls: ReadonlyArray<FilterCall>;
  /** Filters the picture runs through on its own chain before the join. */
  readonly picture?: ReadonlyArray<FilterCall>;
}

/** What one step adds to an ffmpeg run. */
export interface Rendering {
  /** Arguments before the input, such as hardware decoding flags. */
  readonly input: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<FilterCall>;
  /** A second input joined at this step's first filter. */
  readonly side?: SideFilters;
  /** Arguments after the graph, such as the encoder and its options. */
  readonly output: ReadonlyArray<string>;
}

/** The generated clips probes read; `probe-clips.ts` says what each is and how it is made. */
export type ClipName =
  | "h264-8"
  | "h264-10"
  | "hevc-8"
  | "hevc-10"
  | "hevc-pq"
  | "hevc-pq-bare"
  | "hevc-hlg"
  | "av1-8"
  | "av1-10"
  | "vp9-8"
  | "vp9-10"
  | "mpeg2-8"
  | "mpeg2-8-interlaced"
  | "h264-10-interlaced"
  | "h264-8-gray";

/**
 * What a probe of a subtitle row reads back from its first output picture, since an overlay that
 * runs can still ignore the subtitle's transparency: `blend`, that a canvas of a clear, an opaque,
 * and a half-transparent band lands on the gray clip as each should; `glyph`, that libass drew a
 * glyph of the default font where the probe's script puts it (`probe-clips.ts`).
 */
export type Readback = "blend" | "glyph" | "picture";

/** One variant a row proves ahead of use: the operation, run on frames of a generated clip. */
export interface ProbeCase<T extends OpName> {
  readonly op: OpOf<T>;
  readonly clip: ClipName;
  /**
   * How many runs in a row must pass. Decoders run three times: on the Arc A380, VA-API's MPEG-2
   * decoder crashed in 3 of 8 runs, so one pass proves little.
   */
  readonly runs: number;
  /** What the run's first picture must show; none proves the row by its frames alone. */
  readonly readback?: Readback;
}

/** One way to do operation `T` in one domain. */
export interface OpImpl<T extends OpName = OpName> {
  readonly id: ImplId;
  readonly op: T;
  /** The domain it runs in; moves run in their GPU domain. */
  readonly on: Domain;
  /** The memory of the frames it takes. Decoders take packets, which the CPU reads. */
  readonly takes: Domain;
  /** The build components using it for `op` needs. */
  readonly needs: (op: OpOf<T>, input: Frame) => ReadonlyArray<BuildFeature>;
  /** The variant one use exercises; undefined when the row cannot take `input` at all. */
  readonly variant: (op: OpOf<T>, input: Frame) => string | undefined;
  /** The frames it emits; `assemble` binds their device. */
  readonly output: (op: OpOf<T>, input: Frame) => Omit<Frame, "device">;
  readonly render: (op: OpOf<T>, input: Frame) => Rendering;
  readonly probes: ReadonlyArray<ProbeCase<T>>;
  /**
   * Where the row itself takes its frames and how many moves that makes, which a chain's cost
   * counts with its moves and the stage summary shows: libplacebo's upload to a Vulkan device and
   * download back, two moves. None when absent.
   */
  readonly transfers?: Transfers;
  /**
   * A row that does the same operation as the table prefers it done: a chain using this row costs
   * more than one using that row while that row can do the step (its key verified, not set aside)
   * and keeps up (`throughput`), so this one runs where that one cannot.
   */
  readonly fallbackFor?: ImplId;
  /**
   * The frames a second the row sustained on the Arc A380 for outputs of up to each height, the
   * lowest of the measured runs and builds, smallest height first: where it falls below
   * `KEEPS_UP` times the source's frame rate, a row standing in for it (`fallbackFor`) that can do
   * the step is the cheaper choice. None when the row keeps up at any size.
   */
  readonly throughput?: ReadonlyArray<readonly [height: number, framesPerSecond: number]>;
}

/**
 * How many times the source's frame rate a row with a measured `throughput` must sustain to be
 * preferred: enough for a second stream beside the first, and for a restart after a seek to
 * catch up.
 */
const KEEPS_UP = 2.5;

/** The frame rate a source whose rate is unknown is held to, as levels hold it. */
const UNKNOWN_FRAME_RATE = 60;

/**
 * Whether `row` keeps up (`KEEPS_UP`) with a source of `frameRate` at an output `height` lines
 * tall, by the first measured height at or above it, else the tallest.
 */
export const keepsUp = (
  row: { readonly throughput?: OpImpl["throughput"] | undefined },
  height: number,
  frameRate: number | undefined,
): boolean => {
  if (row.throughput === undefined) return true;
  const measured = row.throughput.find(([lines]) => lines >= height) ?? row.throughput.at(-1);

  return measured !== undefined && measured[1] >= KEEPS_UP * (frameRate ?? UNKNOWN_FRAME_RATE);
};

/** The moves a row makes inside itself: to `device` and back, `count` moves in all. */
interface Transfers {
  readonly device: string;
  readonly count: number;
}

/** What a row does with one operation on one frame. */
interface Use {
  readonly variant: string;
  readonly needs: ReadonlyArray<BuildFeature>;
  readonly output: Omit<Frame, "device">;
  readonly rendering: Rendering;
}

/** A row in the table, whatever its operation. */
export interface Row {
  readonly id: ImplId;
  readonly op: OpName;
  readonly on: Domain;
  readonly takes: Domain;
  /** What the row does with `op` on `input`; undefined for another operation or a refused frame. */
  readonly use: (op: Op, input: Frame) => Use | undefined;
  readonly probes: ReadonlyArray<ProbeCase<OpName>>;
  /** The moves the row makes inside itself (`OpImpl.transfers`). */
  readonly transfers: Transfers | undefined;
  /** The row this one stands in for (`OpImpl.fallbackFor`). */
  readonly fallbackFor: ImplId | undefined;
  /** What the row sustains by output height (`OpImpl.throughput`). */
  readonly throughput: OpImpl["throughput"];
}

/** `impl` as a table row. */
export const row = <T extends OpName>(impl: OpImpl<T>): Row => ({
  id: impl.id,
  op: impl.op,
  on: impl.on,
  takes: impl.takes,
  use: (op, input) => {
    if (!Op.$is(impl.op)(op)) return undefined;
    const variant = impl.variant(op, input);

    return variant === undefined
      ? undefined
      : {
          variant,
          needs: impl.needs(op, input),
          output: impl.output(op, input),
          rendering: impl.render(op, input),
        };
  },
  probes: impl.probes.map((probe): ProbeCase<OpName> => {
    const proved: ProbeCase<OpName> = { op: probe.op, clip: probe.clip, runs: probe.runs };

    return probe.readback === undefined ? proved : { ...proved, readback: probe.readback };
  }),
  transfers: impl.transfers,
  fallbackFor: impl.fallbackFor,
  throughput: impl.throughput,
});

/** What the transcoder knows about a GPU domain besides its rows. */
export interface DomainSpec {
  /** The render node it opens, from the configuration. */
  readonly device: (config: MediaConfig.Interface) => string;
  /** Arguments that open the device and name it for filters, before the input. */
  readonly deviceArgs: (device: string) => ReadonlyArray<string>;
  /**
   * Arguments that open the device and a Vulkan device derived from it, which ffmpeg finds by the
   * render node's DRM device, so it is the same GPU and never a software one, named for filters in
   * its place: a chain with a row that runs on Vulkan (`Transfers`) opens these, and the renderer
   * has its uploads and maps name the domain's device.
   */
  readonly vulkanArgs: (device: string) => ReadonlyArray<string>;
  /** Components every use of the domain needs. */
  readonly needs: ReadonlyArray<BuildFeature>;
  /**
   * Whether the frames its processing filters (its rows other than decoders and moves) hand on
   * carry durations in their timestamps' time base. ffmpeg's constant-rate output repeats each
   * frame for its duration, so where they may not, the renderer restates the frame rate once
   * after the last such filter (`video-render.ts`), whichever row the filter belongs to.
   */
  readonly filterDurations: "trusted" | "untrusted";
}

/**
 * The transfer a tone map of PQ and HLG frames works from, what changes whether it works; none for
 * SDR frames and for Dolby Vision's IPT, which only a row that reads the RPU takes.
 */
export const toneMapTransfer = (frame: Frame): "pq" | "hlg" | undefined =>
  frame.colour.signal === "pq" || frame.colour.signal === "hlg" ? frame.colour.signal : undefined;

/**
 * Dynamic HDR metadata, scene by scene: HDR10+ (SMPTE 2094-40) and HDR Vivid (CUVA 005.1). Every
 * tone map maps a source as its static HDR10 base, so rows remove these before the tone map, where
 * libplacebo would read them (on Apple's HDR10+ sample, up to 14 luma codes apart at one frame);
 * the CPU's, VA-API's, and Quick Sync's tone maps read only static metadata.
 */
const DYNAMIC_HDR_METADATA = ["DYNAMIC_HDR_PLUS", "DYNAMIC_HDR_VIVID"] as const;

/** Dolby Vision's RPU, parsed and raw. */
const DOLBY_VISION_METADATA = ["DOVI_METADATA", "DOVI_RPU_BUFFER"] as const;

/**
 * The side data an SDR stream must not keep, from the frame side data types both builds' `sidedata`
 * filter knows (PANSCAN, A53_CC, STEREO3D, MATRIXENCODING, DOWNMIX_INFO, REPLAYGAIN, DISPLAYMATRIX,
 * AFD, MOTION_VECTORS, SKIP_SAMPLES, AUDIO_SERVICE_TYPE, MASTERING_DISPLAY_METADATA, GOP_TIMECODE,
 * SPHERICAL, CONTENT_LIGHT_LEVEL, ICC_PROFILE, S12M_TIMECODE, DYNAMIC_HDR_PLUS, REGIONS_OF_INTEREST,
 * VIDEO_ENC_PARAMS, SEI_UNREGISTERED, FILM_GRAIN_PARAMS, DETECTION_BBOXES, DOVI_RPU_BUFFER,
 * DOVI_METADATA, DYNAMIC_HDR_VIVID, AMBIENT_VIEWING_ENVIRONMENT, VIDEO_HINT, in ffmpeg 7.1 and 9):
 * every one that describes HDR, the source's colour, or how it was meant to be viewed. HDR10's
 * mastering display and content light levels, the dynamic metadata, Dolby Vision's RPU, the
 * ambient viewing environment an iPhone's HLG carries, and an ICC profile of the source's colour.
 * ffmpeg passes each on from the source's frames, and encoders and muxers write them into the
 * stream, so an SDR stream would claim what it no longer is.
 */
const HDR_METADATA = [
  "MASTERING_DISPLAY_METADATA",
  "CONTENT_LIGHT_LEVEL",
  ...DYNAMIC_HDR_METADATA,
  ...DOLBY_VISION_METADATA,
  "AMBIENT_VIEWING_ENVIRONMENT",
  "ICC_PROFILE",
] as const;

/** Filters that remove side data of `types` from frames in any memory. */
const strip = (types: ReadonlyArray<string>): ReadonlyArray<FilterCall> =>
  types.map((type) => filter("sidedata", ["mode", "delete"], ["type", type]));

/** Filters that remove `HDR_METADATA` from frames in any memory. */
export const STRIP_HDR_METADATA: ReadonlyArray<FilterCall> = strip(HDR_METADATA);

/** Filters that remove `DYNAMIC_HDR_METADATA`, which a tone map must not read. */
export const STRIP_DYNAMIC_HDR_METADATA: ReadonlyArray<FilterCall> = strip(DYNAMIC_HDR_METADATA);

/** Filters that remove Dolby Vision's RPU, which only a map of Dolby Vision's IPT may read. */
export const STRIP_DOLBY_VISION_METADATA: ReadonlyArray<FilterCall> = strip(DOLBY_VISION_METADATA);

/**
 * Tags frames SDR BT.709 in limited range, whatever a filter before left on them, so encoders and
 * libass, which reads the matrix to draw text in, see what the samples are.
 */
export const TAG_SDR_BT709: FilterCall = filter(
  "setparams",
  ["color_primaries", "bt709"],
  ["color_trc", "bt709"],
  ["colorspace", "bt709"],
  ["range", "tv"],
);

/** The GPU surface layout frames of `depth` bits use: NV12 for 8 bits, P010 above. */
export const surfaceFormat = (depth: number): "nv12" | "p010le" => (depth > 8 ? "p010le" : "nv12");

/** The bit depth of a GPU surface layout. */
export const surfaceDepth = (format: "nv12" | "p010le"): number => (format === "p010le" ? 10 : 8);

/** A rendering with nothing in it, as a CPU decoder's. */
export const NOTHING: Rendering = { input: [], filters: [], output: [] };

/**
 * The variant of a deinterlacer taking `frame`: its depth, for interlaced frames only. Every
 * deinterlacer works at the source's frame rate, so the rate is not part of it.
 */
export const deinterlaceVariant = (frame: Frame): string | undefined =>
  frame.scan === "interlaced" ? String(frame.depth) : undefined;

/** What proves a deinterlacer: interlaced 8-bit MPEG-2 and interlaced 10-bit H.264. */
export const DEINTERLACE_PROBES: ReadonlyArray<ProbeCase<"Deinterlace">> = [
  { op: Op.Deinterlace(), clip: "mpeg2-8-interlaced", runs: 1 },
  { op: Op.Deinterlace(), clip: "h264-10-interlaced", runs: 1 },
];

/**
 * How an image subtitle's canvas covers the picture. DVD, DVB, and XSUB canvases share the video's
 * own pixel grid (720x576 over an anamorphic picture), so they `stretch` to the picture's size. PGS
 * draws on a square-pixel canvas (1920x1080 even over a picture cropped to 2.39:1, or a 4K one),
 * so it is scaled to the picture's `height` at its own aspect and centred, as players place it: a
 * 1920x1080 canvas is 1422x800 over 1920x800, and over 1440x1080 keeps its size with 240 columns
 * cut from each side, where a caption placed there is cut too.
 */
export const canvasFit = (codec: string): "stretch" | "height" =>
  codec === "hdmv_pgs_subtitle" ? "height" : "stretch";

/** A picture's or a canvas's size in pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The canvas the service states to ffmpeg for an image subtitle of `codec` (`-canvas_size`), only
 * where leaving it unstated is the defect: DVD subtitles carry none (720x576), and ffmpeg learns a
 * PGS stream's only from its first packet, which a 4K file can hold past ffmpeg's probe, sizing it
 * to the picture until then (1920x1080 is Blu-ray's, UHD discs too). Every other codec's input is
 * left as the file has it: a DVB stream's display definition gives its canvas, which a stated one
 * overrides, dropping every caption outside it, and an XSUB stream's is stored with it.
 */
export const statedCanvas = (codec: string): Size | undefined => STATED_CANVASES.get(codec);

const STATED_CANVASES: ReadonlyMap<string, Size> = new Map([
  ["dvd_subtitle", { width: 720, height: 576 }],
  ["hdmv_pgs_subtitle", { width: 1920, height: 1080 }],
]);

/**
 * Where on a `picture` an image subtitle of `codec` is drawn: over all of it when stretched, or for
 * a canvas scaled to the picture's `height` (PGS, 16:9 as Blu-ray's are), the canvas at that height,
 * centred, its middle cut to the picture's width where it is wider (`visibleCanvas`). Each row
 * scales the subtitle's frames to a size it names before anything else, as ffmpeg passes a frame
 * whose canvas changed mid-stream on without rebuilding the graph, and of the filters here only
 * `scale` takes it: Quick Sync's upload fails on it ("Error synchronizing the operation"), and
 * under ffmpeg 9 VA-API's upload, `crop`, and `overlay` abort or crash.
 */
export const drawnCanvas = (codec: string, picture: Size): Size =>
  canvasFit(codec) === "height"
    ? { width: Math.round((picture.height * 16) / 9), height: picture.height }
    : picture;

/** The middle columns of a `canvas` a `picture` of its height shows: a `crop` where it is wider. */
export const visibleCanvas = (canvas: Size, picture: Size): ReadonlyArray<FilterCall> =>
  canvas.width > picture.width
    ? [filter("crop", String(picture.width), String(canvas.height))]
    : [];

/**
 * The image subtitle a probe of an overlay reads: a 320x240 canvas in BGRA, the layout an image
 * subtitle's frames take in ffmpeg (`PROBE_CANVAS`).
 */
export const PROBE_IMAGE_SUBTITLE: SubtitleInput = {
  input: 1,
  stream: 0,
  codec: "rawvideo",
  frame: {
    memory: "cpu",
    device: undefined,
    colour: SDR_BT709,
    depth: 8,
    pixelFormat: "bgra",
    scan: "progressive",
    width: 320,
    height: 240,
  },
};

/** What proves an image subtitle overlay: the probe canvas blended onto the gray clip. */
export const BURN_IMAGE_PROBES: ReadonlyArray<ProbeCase<"BurnImage">> = [
  {
    op: Op.BurnImage({ subtitle: PROBE_IMAGE_SUBTITLE }),
    clip: "h264-8-gray",
    runs: 1,
    readback: "blend",
  },
];

/**
 * What proves a text subtitle row: the probe's script drawn on the gray clip, a glyph read back. A
 * CPU row is verified by the build listing, as every CPU row is, so this runs where a probe of it
 * does (a chain's tests, and any GPU row that draws text); the fonts libass finds come from the
 * image and the NixOS module, which both ship DejaVu.
 */
export const BURN_TEXT_PROBES: ReadonlyArray<ProbeCase<"BurnText">> = [
  {
    op: Op.BurnText({
      subtitle: { codec: "ass", style: "styled", storage: { width: 320, height: 240 } },
    }),
    clip: "h264-8-gray",
    runs: 1,
    readback: "glyph",
  },
];

/** The id of the row that encodes `codec` in `domain`, such as `encode.qsv.hevc`. */
export const encodeRowId = (domain: Domain, codec: OutputCodec): ImplId =>
  ImplId(`encode.${domain}.${codec}`);

/**
 * Whether the encode row of `codec` takes `target`: that codec at 8-bit SDR, the one entry encode
 * rows register.
 */
export const encodesTarget = (codec: OutputCodec, target: OutputTarget): boolean =>
  target.codec === codec && target.depth === 8 && target.colour === "sdr";

/** What proves the encode row of `codec`: one 8-bit SDR encode of the 8-bit H.264 clip. */
export const encodeProbes = (codec: OutputCodec): ReadonlyArray<ProbeCase<"Encode">> => [
  {
    op: Op.Encode({ target: sdrTarget(codec), bitrate: 1_000_000, level: undefined }),
    clip: "h264-8",
    runs: 1,
  },
];
