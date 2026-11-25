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

/** Where frames live: CPU memory or one GPU API's surfaces. A backend adds a member. */
export type Domain = "cpu" | "qsv" | "vaapi";

/** A domain whose frames live on a device. */
export type GpuDomain = Exclude<Domain, "cpu">;

/** What the transcoder encodes to. */
export type OutputCodec = "h264";

/** Whether a frame holds a whole picture or two fields. */
type Scan = "progressive" | "interlaced";

/** What a frame is at one point of a chain. */
export interface Frame {
  /** Which kind of memory holds it. */
  readonly memory: Domain;
  /** The render node of the device that holds it; none in CPU memory. */
  readonly device: string | undefined;
  readonly colour: DynamicRange;
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

/** One video operation. */
export type Op = Data.TaggedEnum<{
  Decode: { readonly codec: string };
  /** `depth` is the bit depth the scaled frames leave in. */
  Scale: { readonly width: number; readonly height: number; readonly depth: number };
  /** HDR to SDR. */
  ToneMap: {};
  BurnImage: { readonly subtitle: SubtitleInput };
  Encode: { readonly codec: OutputCodec; readonly bitrate: number };
  /** Only `assemble` creates moves. */
  Move: { readonly to: Domain };
}>;

/** Constructors and matchers for `Op`. */
export const Op = Data.taggedEnum<Op>();

/** The name of an operation. */
export type OpName = Op["_tag"];

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
  | `decodes:${string}`;

/** One filter of a graph, rendered as `name=arg:key=value`. */
export interface FilterCall {
  readonly name: string;
  /** Positional values and named options, in order. */
  readonly args: ReadonlyArray<string | readonly [string, string]>;
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
  | "hevc-hlg"
  | "av1-8"
  | "av1-10"
  | "vp9-8"
  | "vp9-10"
  | "mpeg2-8";

/** One variant a row proves ahead of use: the operation, run on frames of a generated clip. */
export interface ProbeCase<T extends OpName> {
  readonly op: OpOf<T>;
  readonly clip: ClipName;
  /**
   * How many runs in a row must pass. Decoders run three times: on the Arc A380, VA-API's MPEG-2
   * decoder crashed in 3 of 8 runs, so one pass proves little.
   */
  readonly runs: number;
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
  probes: impl.probes.map((probe): ProbeCase<OpName> => ({
    op: probe.op,
    clip: probe.clip,
    runs: probe.runs,
  })),
});

/** Bit depths rows accept. */
export const DEPTHS: ReadonlySet<number> = new Set([8, 10, 12]);

/** Colours a tone map takes. */
export const HDR_COLOURS: ReadonlySet<DynamicRange> = new Set(["hdr10", "hlg", "dolby-vision"]);

/**
 * The transfer a tone map works from: PQ for HDR10 and Dolby Vision, whose layers in practice
 * carry PQ, and HLG. It is what changes whether a tone map works.
 */
export const transferOf = (colour: DynamicRange): "pq" | "hlg" => (colour === "hlg" ? "hlg" : "pq");

/** The GPU surface layout frames of `depth` bits use: NV12 for 8 bits, P010 above. */
export const surfaceFormat = (depth: number): "nv12" | "p010le" => (depth > 8 ? "p010le" : "nv12");

/** The bit depth of a GPU surface layout. */
export const surfaceDepth = (format: "nv12" | "p010le"): number => (format === "p010le" ? 10 : 8);

/** A rendering with nothing in it, as a CPU decoder's. */
export const NOTHING: Rendering = { input: [], filters: [], output: [] };
