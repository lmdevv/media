/**
 * What a failed ffmpeg run points at, and what the stream does next. `attribute` reads the head of
 * ffmpeg's standard error, where the first role-tagged line names the failing part: a filter by
 * its parsed instance name, the decoder, the encoder, the device, or something that is not video
 * at all (audio, the muxer, the input, the disk). That is a hint, never evidence: the capability
 * service re-probes what it names before it sets anything aside. `advance` bounds the retries: a
 * targeted replacement, then the CPU, then a typed failure, so one position starts ffmpeg at most
 * three times. Pure.
 */
import { Data } from "effect";

import { VIDEO_OPS, type VideoPipeline } from "./video-pipeline.ts";
import type { CapabilityKey, ImplId } from "./video-ops.ts";

/** How a run ended, as attribution reads it. */
export interface RunFailure {
  readonly exitCode: number | null;
  /** The signal that ended it, such as `SIGSEGV`; null when it exited or never started. */
  readonly signal: string | null;
  /** The start of its standard error, paths scrubbed. */
  readonly stderrHead: string;
}

/** Which step owns each name ffmpeg's log lines carry, as the renderer laid the run out. */
export interface LogOwners {
  /** The decoder's step, and the names its lines carry (the codec and the decoder). */
  readonly decoder: { readonly step: number; readonly names: ReadonlyArray<string> } | undefined;
  /** The encoder's step, and the encoder's name. */
  readonly encoder: { readonly step: number; readonly names: ReadonlyArray<string> } | undefined;
  /** Each filter's parsed instance name (`Parsed_vpp_qsv_0`); fused filters name several steps. */
  readonly filters: ReadonlyMap<string, ReadonlyArray<number>>;
}

/** Failures that say nothing about a video capability. */
type NotVideo = "stopped" | "spawn" | "disk" | "input" | "audio" | "mux";

/** What a failed run points at. */
export type Attribution = Data.TaggedEnum<{
  NotVideo: { readonly reason: NotVideo };
  /** Steps to suspect, in order; every step outside the CPU when nothing was named. */
  Video: { readonly named: boolean; readonly suspects: ReadonlyArray<number> };
}>;

/** Constructors and matchers for `Attribution`. */
export const Attribution = Data.taggedEnum<Attribution>();

const TAG = /\[([^\]@[]+?) @ 0x[0-9a-f]+\]/gu;

const DEVICE_TAGS: ReadonlySet<string> = new Set(["VAAPI", "QSV", "AVHWDeviceContext"]);

const DEMUXERS = /^(?:in#\d+|matroska,webm|mpegts|mov,mp4,m4a,3gp,3g2,mj2|avi|mpeg)$/u;

const MUXERS = /^(?:out#\d+\/.+|hls|mp4|mov|null)$/u;

const STOPPED: ReadonlySet<string> = new Set(["SIGKILL", "SIGTERM"]);

const gpuSteps = (pipeline: VideoPipeline): ReadonlyArray<number> =>
  pipeline.steps.flatMap((step, index) => (step.on === "cpu" ? [] : [index]));

const named = (suspects: ReadonlyArray<number>): Attribution =>
  Attribution.Video({ named: true, suspects: [...new Set(suspects)] });

/** What one tag says, or undefined when it names nothing this run owns. */
const ofTag = (
  tag: string,
  stream: string | undefined,
  pipeline: VideoPipeline,
  owners: LogOwners,
): Attribution | undefined => {
  const filter = owners.filters.get(tag);

  if (filter !== undefined) return named(filter);

  if (tag.startsWith("Parsed_")) return Attribution.NotVideo({ reason: "audio" });
  const role = /^(dec|enc):(.+)$/u.exec(tag);
  const name = role?.[2] ?? tag;
  const audio = stream?.startsWith("aist#") === true || stream?.startsWith("aost#") === true;

  if (audio || tag.startsWith("aist#") || tag.startsWith("aost#") || tag.startsWith("af#")) {
    return Attribution.NotVideo({ reason: "audio" });
  }

  const steps = [
    ...(owners.decoder !== undefined &&
    (role?.[1] === "dec" || (role === null && owners.decoder.names.includes(name)))
      ? [owners.decoder.step]
      : []),
    ...(owners.encoder !== undefined &&
    (role?.[1] === "enc" || (role === null && owners.encoder.names.includes(name)))
      ? [owners.encoder.step]
      : []),
  ];

  if (steps.length > 0) return named(steps);

  if (tag.startsWith("vist#") && owners.decoder !== undefined) return named([owners.decoder.step]);

  if (tag.startsWith("vost#") && owners.encoder !== undefined) return named([owners.encoder.step]);

  if (DEVICE_TAGS.has(tag)) return named(gpuSteps(pipeline));

  if (DEMUXERS.test(tag)) return Attribution.NotVideo({ reason: "input" });

  if (MUXERS.test(tag)) return Attribution.NotVideo({ reason: "mux" });

  return undefined;
};

/** What one line of standard error says, or undefined when it names nothing. */
const ofLine = (
  line: string,
  pipeline: VideoPipeline,
  owners: LogOwners,
): Attribution | undefined => {
  if (/No space left on device|Disk quota exceeded/u.test(line)) {
    return Attribution.NotVideo({ reason: "disk" });
  }

  if (/^Device creation failed|for option 'init_hw_device'/u.test(line)) {
    return named(gpuSteps(pipeline));
  }

  const tags = [...line.matchAll(TAG)].map((match) => match[1] ?? "");
  const stream = tags.length > 1 ? tags[0] : undefined;

  for (const tag of tags.toReversed()) {
    const said = ofTag(tag, stream, pipeline, owners);

    if (said !== undefined) return said;
  }

  return undefined;
};

/**
 * What a failed run of `pipeline` points at: its first line that names a part, a signal that
 * stopped it, or, with nothing named, every step outside the CPU.
 */
export const attribute = (
  pipeline: VideoPipeline,
  owners: LogOwners,
  failure: RunFailure,
): Attribution => {
  if (failure.signal !== null && STOPPED.has(failure.signal)) {
    return Attribution.NotVideo({ reason: "stopped" });
  }

  if (failure.exitCode === null && failure.signal === null) {
    return Attribution.NotVideo({ reason: "spawn" });
  }

  for (const line of failure.stderrHead.split("\n")) {
    const said = ofLine(line, pipeline, owners);

    if (said !== undefined) return said;
  }

  return Attribution.Video({ named: false, suspects: gpuSteps(pipeline) });
};

/** What the capability service found when it checked the suspects of a failure. */
export type Diagnosis = Data.TaggedEnum<{
  /** A suspect's probe failed again: its key is quarantined. */
  Capability: {
    readonly keys: ReadonlyArray<CapabilityKey>;
    readonly impls: ReadonlyArray<ImplId>;
  };
  /** Every suspect's probe passed: the source is the cause, and it is kept from these rows. */
  Source: { readonly impls: ReadonlyArray<ImplId> };
  /** The probes ran out of time: no verdict, and this stream keeps off these rows. */
  Undecided: { readonly impls: ReadonlyArray<ImplId> };
  NotVideo: { readonly reason: NotVideo };
  /** Nothing to suspect: the run was on the CPU and named nothing it owns. */
  Unexplained: {};
}>;

/** Constructors and matchers for `Diagnosis`. */
export const Diagnosis = Data.taggedEnum<Diagnosis>();

/** A stream's failures since it last served a segment, and the rows it keeps off for good. */
export interface RecoveryState {
  readonly failures: number;
  readonly excluded: ReadonlySet<ImplId>;
}

/** A stream that has not failed. */
export const fresh: RecoveryState = { failures: 0, excluded: new Set() };

/** What a stream does after a failure. */
export type Recovery = Data.TaggedEnum<{
  /** Plans again, keeping off `state.excluded`. */
  Replan: { readonly state: RecoveryState };
  GiveUp: {};
}>;

/** Constructors and matchers for `Recovery`. */
export const Recovery = Data.taggedEnum<Recovery>();

/** How many runs one position may start. */
const MOST_RUNS = 3;

const GPU_ROWS: ReadonlyArray<ImplId> = VIDEO_OPS.flatMap((entry) =>
  entry.on === "cpu" ? [] : [entry.id],
);

/**
 * The next move after a failure of `failed`: the first replans without what the diagnosis points
 * at, the second keeps off every row outside the CPU for the rest of the stream, the third gives
 * up. A failure that points at nothing goes to the CPU at once, and gives up when it is already
 * there. Exclusions only grow.
 */
export const advance = (
  state: RecoveryState,
  diagnosis: Diagnosis,
  failed: VideoPipeline,
): Recovery => {
  const failures = state.failures + 1;

  if (failures >= MOST_RUNS) return Recovery.GiveUp();
  const onGpu = failed.steps.some((step) => step.on !== "cpu");
  const everyGpuRow = new Set([...state.excluded, ...GPU_ROWS]);

  const toCpu =
    onGpu && GPU_ROWS.some((impl) => !state.excluded.has(impl))
      ? Recovery.Replan({ state: { failures, excluded: everyGpuRow } })
      : Recovery.GiveUp();

  const targeted = (impls: ReadonlyArray<ImplId>) =>
    failures >= 2
      ? toCpu
      : Recovery.Replan({ state: { failures, excluded: new Set([...state.excluded, ...impls]) } });

  return Diagnosis.$match(diagnosis, {
    Capability: ({ impls }) => targeted(impls),
    Source: ({ impls }) => targeted(impls),
    Undecided: ({ impls }) => targeted(impls),
    NotVideo: () => toCpu,
    Unexplained: () => toCpu,
  });
};
