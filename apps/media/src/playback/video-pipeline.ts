/**
 * Video pipelines: chains of rows from the operation table. `assemble` is the only constructor of
 * a pipeline. It walks the chosen rows, inserts the move each pair of memories needs, asks each
 * row what it does with the frame it gets, and refuses any step whose capability the snapshot has
 * not verified, so a GPU filter fed CPU frames, an H.264 encoder fed HDR frames, or an unproven
 * stage cannot be written. A chain that runs decodes first and encodes last. The renderer takes
 * only a pipeline `assemble` itself returned, not a copy. `planVideo` picks the cheapest chain
 * that assembles; it names no backend, so a new one is a rows file and a `Domain` member.
 */
import type { DynamicRange } from "@media/contracts/media-playback";
import { Data, Result } from "effect";

import type { VideoStream } from "../media/media-probe.ts";
import { fitLevel, statedLevel } from "./output-levels.ts";
import { PROBE_CLIPS } from "./probe-clips.ts";
import { CPU_ROWS } from "./video-ops-cpu.ts";
import { INTEL_ROWS, QSV, VAAPI } from "./video-ops-intel.ts";
import {
  BITRATE_SHARE,
  type BuildFeature,
  type CapabilityKey,
  capabilityKey,
  type ClipName,
  type Domain,
  type DomainSpec,
  type Frame,
  type GpuDomain,
  ImplId,
  implOf,
  Op,
  type OpName,
  type OutputCodec,
  type OutputTarget,
  type Rendering,
  type Row,
  type SourceVideo,
  type SubtitleInput,
  toneMapsTo,
} from "./video-ops.ts";

/** Every row of the table. A backend adds its file's rows here. */
export const VIDEO_OPS: ReadonlyArray<Row> = [...CPU_ROWS, ...INTEL_ROWS];

/** What the transcoder knows about each GPU domain besides its rows. A backend adds its entry. */
export const DOMAINS: Readonly<Record<GpuDomain, DomainSpec>> = { qsv: QSV, vaapi: VAAPI };

/** The ffmpeg filter the renderer restates the frame rate with (`video-render.ts`). */
export const RATE_FILTER = "fps";

/**
 * Whether a row doing `op` in `on` with `rendering` runs a processing filter of a domain whose
 * filters leave durations untrusted (`DomainSpec.filterDurations`): filters, and neither a decoder
 * nor a move. The renderer restates the frame rate after the last such step, so each needs
 * `RATE_FILTER` from the build as well as its own filters.
 */
export const leavesUntrustedDurations = (on: Domain, op: Op, rendering: Rendering): boolean =>
  on !== "cpu" &&
  DOMAINS[on].filterDurations === "untrusted" &&
  rendering.filters.length > 0 &&
  !Op.$is("Decode")(op) &&
  !Op.$is("Move")(op);

/** GPU domains in the order `HARDWARE_ACCELERATION=auto` prefers them. */
export const GPU_PREFERENCE: ReadonlyArray<GpuDomain> = ["qsv", "vaapi"];

/** One step of a pipeline: a row doing one operation on one frame. */
export interface Step {
  readonly impl: ImplId;
  readonly op: Op;
  /** The domain the row runs in. */
  readonly on: Domain;
  /** The inventory key of what this step exercises. */
  readonly capability: CapabilityKey;
  readonly needs: ReadonlyArray<BuildFeature>;
  readonly input: Frame;
  readonly output: Frame;
  readonly rendering: Rendering;
}

const checked: unique symbol = Symbol("VideoPipeline");

/**
 * A chain `assemble` built. Only this module holds the symbol, so no other module can write one
 * out, and `isAssembled` tells `assemble`'s own results from copies.
 */
export interface VideoPipeline {
  readonly steps: ReadonlyArray<Step>;
  readonly [checked]: true;
}

/** Every pipeline `assemble` returned, and nothing else: a copy of one is not in it. */
const assembledPipelines = new WeakSet<VideoPipeline>();

/** Whether `assemble` returned `pipeline` itself, as the renderer requires. */
export const isAssembled = (pipeline: VideoPipeline): boolean => assembledPipelines.has(pipeline);

/** A GPU domain planning may use, and the render node it binds. */
export interface DomainBinding {
  readonly domain: GpuDomain;
  readonly device: string;
}

/** What planning may use right now, for one file. */
export interface CapabilitySnapshot {
  /** GPU domains in preference order; the CPU is always available, after them. */
  readonly domains: ReadonlyArray<DomainBinding>;
  readonly verified: ReadonlySet<CapabilityKey>;
  /** Rows this file and this session must not use. */
  readonly excluded: ReadonlySet<ImplId>;
}

/** Why a chain is assembled: to run, or to prove the one key a probe exists for. */
export type Purpose = Data.TaggedEnum<{
  Run: {};
  Probe: { readonly key: CapabilityKey };
}>;

/** Constructors and matchers for `Purpose`. */
export const Purpose = Data.taggedEnum<Purpose>();

/** Why a chain cannot be assembled. */
export type Rejection = Data.TaggedEnum<{
  /** The row cannot take the frame it would get. */
  Refused: { readonly impl: ImplId; readonly frame: Frame };
  /** No row moves frames between these memories. */
  NoMove: { readonly from: Domain; readonly to: Domain };
  /** The snapshot binds no device for the domain. */
  Unavailable: { readonly domain: Domain };
  Excluded: { readonly impl: ImplId };
  /** `on` and `needs` are the unverified step's, so a listing can settle it. */
  NotVerified: {
    readonly key: CapabilityKey;
    readonly on: Domain;
    readonly needs: ReadonlyArray<BuildFeature>;
  };
  /** The chain would hold frames on a second GPU device context. */
  SecondDevice: { readonly memory: Domain; readonly device: string };
  /** A chain that runs must decode first and encode last; this one lacks `needs` there. */
  Incomplete: { readonly needs: "Decode" | "Encode" };
  /** No operation needs a row. */
  Empty: {};
}>;

/** Constructors and matchers for `Rejection`. */
export const Rejection = Data.taggedEnum<Rejection>();

/** Evidence checks during assembly; `structure` skips them, to list the keys chains could use. */
type Checks = Data.TaggedEnum<{
  Evidence: { readonly purpose: Purpose };
  Structure: {};
}>;

const Checks = Data.taggedEnum<Checks>();

/** Width and height. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/** What a decision wants from an encode; it names no backend. */
export interface VideoIntent {
  /**
   * What the encode may produce, the most wanted first; the planner tries them in this order, and
   * maps HDR to SDR for each target that asks for SDR (`toneMapsTo`).
   */
  readonly targets: ReadonlyArray<OutputTarget>;
  /**
   * The most frames a second the source carries, as its probe reads them, which a target's level
   * limits with the picture; a level holds an unknown rate to 60.
   */
  readonly frameRate: number | undefined;
  /** The client's limits and the viewer's height cap. */
  readonly bounds: Size;
  /** The largest picture the CPU encodes. */
  readonly cpuEncodeBounds: Size;
  readonly maxBitrate: number | undefined;
  /** An image subtitle drawn onto the picture. */
  readonly burnImage: SubtitleInput | undefined;
}

/** What an encode produces. */
export interface VideoOutput extends Size {
  readonly codec: OutputCodec;
  readonly bitrate: number;
  readonly dynamicRange: DynamicRange;
}

/** A chosen pipeline and what it produces. */
export interface PlannedVideo {
  readonly pipeline: VideoPipeline;
  readonly output: VideoOutput;
}

/** The source of `video` as rows see it; the one mapping from ffprobe. */
export const sourceOf = (video: VideoStream): SourceVideo => ({
  codec: video.codec,
  pixelFormat: video.pixelFormat ?? (video.bitDepth > 8 ? "yuv420p10le" : "yuv420p"),
  depth: video.bitDepth,
  colour: video.dynamicRange,
  scan: "progressive",
  width: video.width,
  height: video.height,
});

/** The frame a source enters a chain as: packets the CPU reads. */
const packetsOf = (source: SourceVideo): Frame => ({
  memory: "cpu",
  device: undefined,
  colour: source.colour,
  depth: source.depth,
  pixelFormat: source.pixelFormat,
  scan: source.scan,
  width: source.width,
  height: source.height,
});

const rowById = new Map(VIDEO_OPS.map((entry) => [entry.id, entry]));

const moveRow = (from: Domain, to: Domain): Row | undefined =>
  rowById.get(ImplId(`move.${from}>${to}`));

const contextOf = (frame: Frame): string | undefined =>
  frame.memory === "cpu" ? undefined : `${frame.memory}@${frame.device ?? ""}`;

/**
 * Builds the chain for `choices`, inserting moves. Each step's capability must be verified and its
 * row not excluded, except under `Structure`, and except the one key a probe proves.
 */
const build = (
  source: SourceVideo,
  choices: ReadonlyArray<readonly [Op, Row]>,
  snapshot: CapabilitySnapshot,
  checks: Checks,
): Result.Result<ReadonlyArray<Step>, Rejection> => {
  const steps: Array<Step> = [];
  const contexts = new Set<string>();
  let frame = packetsOf(source);

  const deviceOf = (domain: Domain): string | undefined =>
    snapshot.domains.find((binding) => binding.domain === domain)?.device;

  const place = (op: Op, entry: Row): Rejection | undefined => {
    if (entry.on !== "cpu" && deviceOf(entry.on) === undefined) {
      return Rejection.Unavailable({ domain: entry.on });
    }

    const use = entry.use(op, frame);

    if (use === undefined) return Rejection.Refused({ impl: entry.id, frame });
    const key = capabilityKey(entry.id, use.variant);

    const needs: ReadonlyArray<BuildFeature> = leavesUntrustedDurations(entry.on, op, use.rendering)
      ? [...use.needs, `filter:${RATE_FILTER}`]
      : use.needs;

    if (Checks.$is("Evidence")(checks)) {
      if (snapshot.excluded.has(entry.id)) return Rejection.Excluded({ impl: entry.id });

      const exempt = Purpose.$match(checks.purpose, {
        Run: () => false,
        Probe: (probe) => probe.key === key,
      });

      if (!exempt && !snapshot.verified.has(key)) {
        return Rejection.NotVerified({ key, on: entry.on, needs });
      }
    }

    const output: Frame = { ...use.output, device: deviceOf(use.output.memory) };
    const context = contextOf(output);

    if (context !== undefined) {
      contexts.add(context);

      if (contexts.size > 1) {
        return Rejection.SecondDevice({ memory: output.memory, device: output.device ?? "" });
      }
    }

    steps.push({
      impl: entry.id,
      op,
      on: entry.on,
      capability: key,
      needs,
      input: frame,
      output,
      rendering: use.rendering,
    });
    frame = output;

    return undefined;
  };

  for (const [op, entry] of choices) {
    if (entry.takes !== frame.memory) {
      const move = moveRow(frame.memory, entry.takes);

      if (move === undefined)
        return Result.fail(Rejection.NoMove({ from: frame.memory, to: entry.takes }));
      const moved = place(Op.Move({ to: entry.takes }), move);

      if (moved !== undefined) return Result.fail(moved);
    }

    const placed = place(op, entry);

    if (placed !== undefined) return Result.fail(placed);
  }

  return steps.length === 0 ? Result.fail(Rejection.Empty()) : Result.succeed(steps);
};

/**
 * The only constructor of a pipeline. `choices` are operations and the rows to do them, in order;
 * the moves between memories are inserted, and a `Move` given as a choice is placed where it
 * stands, as probes use to visit a memory. Every step's capability must be verified in `snapshot`
 * and its row not excluded, except the one key a probe proves, and the chain may hold frames on at
 * most one GPU device context besides the CPU. A chain to run must decode first and encode last;
 * a probe's chain may stop anywhere.
 */
export const assemble = (
  source: SourceVideo,
  choices: ReadonlyArray<readonly [Op, Row]>,
  snapshot: CapabilitySnapshot,
  purpose: Purpose,
): Result.Result<VideoPipeline, Rejection> => {
  const built = build(source, choices, snapshot, Checks.Evidence({ purpose }));

  if (Result.isFailure(built)) return Result.fail(built.failure);
  const steps = built.success;

  if (Purpose.$is("Run")(purpose)) {
    const first = steps[0];
    const last = steps.at(-1);

    if (first === undefined || !Op.$is("Decode")(first.op)) {
      return Result.fail(Rejection.Incomplete({ needs: "Decode" }));
    }

    if (last === undefined || !Op.$is("Encode")(last.op)) {
      return Result.fail(Rejection.Incomplete({ needs: "Encode" }));
    }
  }

  const pipeline: VideoPipeline = { steps, [checked]: true };

  assembledPipelines.add(pipeline);

  return Result.succeed(pipeline);
};

/** The rows of `op`, in table order. */
export const rowsOf = (op: OpName): ReadonlyArray<Row> =>
  VIDEO_OPS.filter((entry) => entry.op === op);

/** The row with `id`. */
export const rowOf = (id: ImplId): Row | undefined => rowById.get(id);

const SDR_BITRATES: ReadonlyArray<readonly [number, number]> = [
  [1440, 20_000_000],
  [1080, 12_000_000],
  [720, 8_000_000],
  [480, 4_000_000],
];

/**
 * The bitrate of an encode `height` pixels tall to `codec`, within `maxBitrate`: H.264's table
 * scaled by the codec's share.
 */
const outputBitrate = (height: number, codec: OutputCodec, maxBitrate: number): number =>
  Math.min(
    Math.round(
      (SDR_BITRATES.find(([above]) => height > above)?.[1] ?? 2_000_000) * BITRATE_SHARE[codec],
    ),
    maxBitrate,
  );

/** The source's size scaled down, never up, to fit `bounds`, in even dimensions. */
const fit = (source: Size, bounds: Size): Size => {
  const scale = Math.min(1, bounds.width / source.width, bounds.height / source.height);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);

  return { width: even(source.width), height: even(source.height) };
};

const product = <A>(lists: ReadonlyArray<ReadonlyArray<A>>): ReadonlyArray<ReadonlyArray<A>> =>
  lists.reduce<ReadonlyArray<ReadonlyArray<A>>>(
    (combinations, list) =>
      combinations.flatMap((combination) => list.map((item) => [...combination, item])),
    [[]],
  );

interface Candidate {
  readonly choices: ReadonlyArray<readonly [Op, Row]>;
  readonly encode: Row;
  /** The target's place in the intent's order. */
  readonly rank: number;
}

/**
 * Every chain that could encode `source` for `intent` within the snapshot's domains: each encode
 * row with each target it may produce (on the CPU only those that allow it) sizes the picture
 * (the CPU within its bounds) and the bitrate within the target's level at the source's frame
 * rate, skipping a target whose level holds that rate at no size; the scale leaves frames at the
 * source's depth or at 8 bits, whichever the rows after it take, and a tone map runs where the
 * target asks for SDR from HDR.
 */
const candidates = (
  source: SourceVideo,
  intent: VideoIntent,
  snapshot: CapabilitySnapshot,
): ReadonlyArray<Candidate> => {
  const bound = new Set<Domain>(["cpu", ...snapshot.domains.map((binding) => binding.domain)]);
  // The source's depth first: of two chains that cost the same, the one that keeps depth longer.
  const depths = [...new Set([source.depth, 8])];

  const usable = (op: Op) =>
    VIDEO_OPS.filter((entry) => Op.$is(entry.op)(op) && bound.has(entry.on));

  const encodes = VIDEO_OPS.filter((entry) => entry.op === "Encode" && bound.has(entry.on));

  return intent.targets.flatMap((target, rank) =>
    encodes.flatMap((encode) => {
      if (encode.on === "cpu" && target.cpuEncode === "refused") return [];

      const fitted = fitLevel(
        target.codec,
        target.level,
        fit(
          source,
          encode.on === "cpu"
            ? {
                width: Math.min(intent.bounds.width, intent.cpuEncodeBounds.width),
                height: Math.min(intent.bounds.height, intent.cpuEncodeBounds.height),
              }
            : intent.bounds,
        ),
        intent.frameRate,
      );

      if (fitted === undefined) return [];
      const { size } = fitted;

      const bitrate = outputBitrate(
        size.height,
        target.codec,
        Math.min(
          intent.maxBitrate ?? Number.POSITIVE_INFINITY,
          fitted.maxBitrate ?? Number.POSITIVE_INFINITY,
        ),
      );

      const encodeOp = Op.Encode({
        target,
        bitrate,
        level: statedLevel(target.codec, target.level, size, intent.frameRate, bitrate),
      });

      return depths.flatMap((depth) => {
        const ops: ReadonlyArray<Op> = [
          Op.Decode({ codec: source.codec }),
          Op.Scale({ ...size, depth }),
          ...(toneMapsTo(source.colour, target) ? [Op.ToneMap()] : []),
          ...(intent.burnImage === undefined ? [] : [Op.BurnImage({ subtitle: intent.burnImage })]),
        ];

        return product(ops.map(usable)).map((rows): Candidate => ({
          choices: [
            ...ops.flatMap((op, index) => {
              const chosen = rows[index];

              return chosen === undefined ? [] : [[op, chosen] as const];
            }),
            [encodeOp, encode],
          ],
          encode,
          rank,
        }));
      });
    }),
  );
};

/**
 * How much a chain costs, compared in order: an encode on the CPU, the target's place in the
 * intent's order, CPU work, moves between memories, then the snapshot's domain preference.
 */
const costOf = (
  steps: ReadonlyArray<Step>,
  candidate: Candidate,
  snapshot: CapabilitySnapshot,
): ReadonlyArray<number> => {
  const gpu = steps.find((step) => step.on !== "cpu")?.on;
  const rank = snapshot.domains.findIndex((binding) => binding.domain === gpu);

  return [
    candidate.encode.on === "cpu" ? 1 : 0,
    candidate.rank,
    steps.filter((step) => step.on === "cpu" && !Op.$is("Move")(step.op)).length,
    steps.filter((step) => Op.$is("Move")(step.op)).length,
    rank === -1 ? snapshot.domains.length : rank,
  ];
};

const cheaper = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean => {
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;

    if (value !== other) return value < other;
  }

  return false;
};

interface Ranked {
  readonly candidate: Candidate;
  readonly steps: ReadonlyArray<Step>;
  readonly cost: ReadonlyArray<number>;
}

const cheapest = (
  source: SourceVideo,
  intent: VideoIntent,
  snapshot: CapabilitySnapshot,
  checks: Checks,
): Result.Result<Ranked, Rejection> => {
  let best: Ranked | undefined;
  let first: Rejection | undefined;

  for (const candidate of candidates(source, intent, snapshot)) {
    const built = build(source, candidate.choices, snapshot, checks);

    if (Result.isFailure(built)) {
      first ??= built.failure;
    } else {
      const cost = costOf(built.success, candidate, snapshot);

      if (best === undefined || cheaper(cost, best.cost)) {
        best = { candidate, steps: built.success, cost };
      }
    }
  }

  if (best !== undefined) return Result.succeed(best);

  return Result.fail(first ?? Rejection.Empty());
};

/**
 * The cheapest pipeline that encodes `source` for `intent` from what `snapshot` verifies. With no
 * chain left it answers why the cheapest chain this build could run is refused.
 */
export const planVideo = (
  source: SourceVideo,
  intent: VideoIntent,
  snapshot: CapabilitySnapshot,
): Result.Result<PlannedVideo, Rejection> => {
  const chosen = cheapest(source, intent, snapshot, Checks.Evidence({ purpose: Purpose.Run() }));

  if (Result.isFailure(chosen)) {
    const possible = cheapest(source, intent, snapshot, Checks.Structure());

    if (Result.isFailure(possible)) return Result.fail(possible.failure);

    const refused = build(
      source,
      possible.success.candidate.choices,
      snapshot,
      Checks.Evidence({ purpose: Purpose.Run() }),
    );

    return Result.fail(Result.isFailure(refused) ? refused.failure : chosen.failure);
  }

  const pipeline = assemble(source, chosen.success.candidate.choices, snapshot, Purpose.Run());

  if (Result.isFailure(pipeline)) return Result.fail(pipeline.failure);
  const last = pipeline.success.steps.at(-1);

  if (last === undefined || !Op.$is("Encode")(last.op)) return Result.fail(Rejection.Empty());

  return Result.succeed({
    pipeline: pipeline.success,
    output: {
      codec: last.op.target.codec,
      width: last.output.width,
      height: last.output.height,
      bitrate: last.op.bitrate,
      dynamicRange: last.output.colour,
    },
  });
};

/**
 * Every capability some chain for `source` and `intent` could use within the snapshot's domains,
 * with a step that uses it: what to resolve before planning.
 */
export const candidateKeys = (
  source: SourceVideo,
  intent: VideoIntent,
  snapshot: CapabilitySnapshot,
): ReadonlyMap<CapabilityKey, Step> => {
  const keys = new Map<CapabilityKey, Step>();

  for (const candidate of candidates(source, intent, snapshot)) {
    const built = build(source, candidate.choices, snapshot, Checks.Structure());

    if (Result.isSuccess(built)) {
      for (const step of built.success) {
        if (!keys.has(step.capability)) keys.set(step.capability, step);
      }
    }
  }

  return keys;
};

/** Whether the pipeline runs any step outside the CPU. */
export const usesGpu = (pipeline: VideoPipeline): boolean =>
  pipeline.steps.some((step) => step.on !== "cpu");

/** The domain the pipeline encodes in. */
export const encodeDomain = (pipeline: VideoPipeline): Domain =>
  pipeline.steps.find((step) => Op.$is("Encode")(step.op))?.on ?? "cpu";

/** Whether two pipelines exercise the same capabilities in the same order. */
export const samePipeline = (left: VideoPipeline, right: VideoPipeline): boolean =>
  left.steps.length === right.steps.length &&
  left.steps.every((step, index) => step.capability === right.steps[index]?.capability);

/** Whether every step of `pipeline` may still run under `snapshot`. */
export const stillVerified = (pipeline: VideoPipeline, snapshot: CapabilitySnapshot): boolean =>
  pipeline.steps.every(
    (step) => snapshot.verified.has(step.capability) && !snapshot.excluded.has(step.impl),
  );

/** How a probe reads its frames. */
export type ProbeInput = Data.TaggedEnum<{
  /** A generated clip. */
  Clip: { readonly clip: ClipName };
  /** The first second of a real source's video stream. */
  Source: {};
}>;

/** Constructors and matchers for `ProbeInput`. */
export const ProbeInput = Data.taggedEnum<ProbeInput>();

/** The smallest chain that proves one key, and what it reads. */
export interface ProbePlan {
  readonly key: CapabilityKey;
  readonly pipeline: VideoPipeline;
  readonly input: ProbeInput;
  readonly runs: number;
}

const decodeCpu = rowById.get(ImplId("decode.cpu"));

/**
 * The choices that feed `entry` doing `op` on `source` and drain it: decoders read their input
 * and, on a GPU, download, so a decoder that fell back to software fails; uploads stop on the
 * device; downloads first upload; other rows read CPU-decoded frames, moved in as they need.
 * ffmpeg's null output takes frames in any memory.
 */
const probeChoices = (
  entry: Row,
  op: Op,
  source: SourceVideo,
): ReadonlyArray<readonly [Op, Row]> | undefined => {
  if (decodeCpu === undefined) return undefined;
  const decoded: readonly [Op, Row] = [Op.Decode({ codec: source.codec }), decodeCpu];

  if (entry.op === "Decode") {
    const download = entry.on === "cpu" ? undefined : moveRow(entry.on, "cpu");

    return download === undefined
      ? [[op, entry]]
      : [
          [op, entry],
          [Op.Move({ to: "cpu" }), download],
        ];
  }

  if (entry.op === "Move" && entry.takes !== "cpu") {
    const upload = moveRow("cpu", entry.takes);

    return upload === undefined
      ? undefined
      : [decoded, [Op.Move({ to: entry.takes }), upload], [op, entry]];
  }

  return [decoded, [op, entry]];
};

/**
 * The probe chain for `entry` doing `op` on `source`, when it exercises `key`: assembled, or why
 * it cannot be yet. Undefined when the chain would prove another variant.
 */
const probeAssembled = (
  entry: Row,
  op: Op,
  source: SourceVideo,
  snapshot: CapabilitySnapshot,
  key: CapabilityKey,
): Result.Result<VideoPipeline, Rejection> | undefined => {
  const choices = probeChoices(entry, op, source);

  if (choices === undefined) return undefined;
  const chain = build(source, choices, snapshot, Checks.Structure());

  if (Result.isFailure(chain) || !chain.success.some((step) => step.capability === key)) {
    return undefined;
  }

  return assemble(source, choices, snapshot, Purpose.Probe({ key }));
};

/**
 * The generated-clip probe that proves `key`, or why it cannot run yet: a step it relies on that
 * is not verified, for example. Undefined when no generated clip exercises `key`.
 */
export const probeFor = (
  key: CapabilityKey,
  snapshot: CapabilitySnapshot,
): Result.Result<ProbePlan, Rejection> | undefined => {
  const entry = rowById.get(implOf(key));

  if (entry === undefined) return undefined;
  let blocked: Rejection | undefined;

  for (const probe of entry.probes) {
    const source = PROBE_CLIPS[probe.clip].source;
    const built = probeAssembled(entry, probe.op, source, snapshot, key);

    if (built !== undefined && Result.isSuccess(built)) {
      return Result.succeed({
        key,
        pipeline: built.success,
        input: ProbeInput.Clip({ clip: probe.clip }),
        runs: probe.runs,
      });
    }

    if (built !== undefined && Result.isFailure(built)) blocked ??= built.failure;
  }

  return blocked === undefined ? undefined : Result.fail(blocked);
};

/**
 * The probe that proves decoder key `key` on a real source's first second, for a codec and layout
 * no generated clip has; its evidence belongs to that source alone.
 */
export const sourceProbeFor = (
  key: CapabilityKey,
  source: SourceVideo,
  snapshot: CapabilitySnapshot,
): Result.Result<ProbePlan, Rejection> | undefined => {
  const entry = rowById.get(implOf(key));

  if (entry === undefined || entry.op !== "Decode") return undefined;
  const built = probeAssembled(entry, Op.Decode({ codec: source.codec }), source, snapshot, key);

  return built === undefined
    ? undefined
    : Result.map(built, (pipeline) => ({ key, pipeline, input: ProbeInput.Source(), runs: 1 }));
};

const WARMUP_ORDER: ReadonlyArray<OpName> = [
  "Move",
  "Encode",
  "Scale",
  "Decode",
  "ToneMap",
  "BurnImage",
];

/** The codecs most sources are, whose 8-bit decoders warmup proves first. */
const COMMON_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"]);

/** The codec every client plays, whose encoder warmup proves first. */
const COMMON_OUTPUT: OutputCodec = "h264";

/**
 * Whether `step` belongs to the chain most files play through: 8-bit SDR H.264 or HEVC, encoded
 * to H.264.
 */
const common = (step: Step): boolean =>
  step.input.depth === 8 &&
  step.output.depth === 8 &&
  step.output.colour === "sdr" &&
  Op.$match(step.op, {
    Decode: ({ codec }) => COMMON_CODECS.has(codec),
    Scale: () => true,
    ToneMap: () => true,
    BurnImage: () => false,
    Encode: ({ target }) => target.codec === COMMON_OUTPUT,
    Move: () => true,
  });

/**
 * The steps generated clips prove for the rows of `domain`, one per key: first those of the chain
 * most files play through (8-bit moves, the H.264 encoder, scaling, H.264 and HEVC decoding), then
 * the rest, each group in the order most chains need them: moves, the encoders, scaling, decoders,
 * then tone maps.
 */
export const probedSteps = (domain: Domain, snapshot: CapabilitySnapshot): ReadonlyArray<Step> => {
  const steps = new Map<CapabilityKey, Step>();

  const rows = VIDEO_OPS.filter((entry) => entry.on === domain).toSorted(
    (left, right) => WARMUP_ORDER.indexOf(left.op) - WARMUP_ORDER.indexOf(right.op),
  );

  for (const entry of rows) {
    for (const probe of entry.probes) {
      const source = PROBE_CLIPS[probe.clip].source;
      const choices = probeChoices(entry, probe.op, source);

      const chain =
        choices === undefined ? undefined : build(source, choices, snapshot, Checks.Structure());

      const tested =
        chain !== undefined && Result.isSuccess(chain)
          ? chain.success.find((step) => step.impl === entry.id && Op.$is(entry.op)(step.op))
          : undefined;

      if (tested !== undefined && !steps.has(tested.capability))
        steps.set(tested.capability, tested);
    }
  }

  const all = [...steps.values()];

  return [...all.filter(common), ...all.filter((step) => !common(step))];
};
