/**
 * What a failed ffmpeg run points at, and what the stream does next. `attribute` reads the end of
 * ffmpeg's standard error. A stop or a full disk settles it wherever it stands, as a run never
 * recovers from either; otherwise the line that ended the run decides: the last line that names a
 * part, past what ffmpeg writes about every part a failure stopped. It may say a part other than
 * the video failed (the muxer, the input, the audio), or name the failing video part: a filter by
 * its parsed instance name, the decoder, the encoder, or the device. Earlier lines are warnings
 * the run went on past. A named part is a hint, never evidence: the capability service re-probes
 * what it names before it sets anything aside. `advance` bounds the retries: a targeted
 * replacement, then the CPU, then a typed failure, so one position starts ffmpeg at most three
 * times. Pure.
 */
import { Data } from "effect";

import { VIDEO_OPS, type VideoPipeline } from "./video-pipeline.ts";
import type { CapabilityKey, ImplId } from "./video-ops.ts";

/** How a run ended, as attribution reads it. */
export interface RunFailure {
  readonly exitCode: number | null;
  /** The signal that ended it, such as `SIGSEGV`; null when it exited or never started. */
  readonly signal: string | null;
  /** The end of its standard error, paths scrubbed, where the line that ended the run is. */
  readonly stderrTail: string;
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

const DEMUXERS = /^(?:in#\d+(?:\/.+)?|matroska,webm|mpegts|mov,mp4,m4a,3gp,3g2,mj2|avi|mpeg)$/u;

const MUXERS = /^(?:out#\d+\/.+|hls|mp4|mov|null)$/u;

const STOPPED: ReadonlySet<string> = new Set(["SIGKILL", "SIGTERM"]);

/** The filters of the audio graph the service writes (`-af`). */
const AUDIO_FILTERS = /^Parsed_(?:aresample|anull|asetpts)_\d+$/u;

/** A full disk, whichever part met it. */
const DISK_FULL = /No space left on device|Disk quota exceeded/u;

/** What ffmpeg writes when a signal ended it. */
const ENDED_BY_SIGNAL = /received signal \d+|system signals, hard exiting/u;

/**
 * What ffmpeg writes after a part failed, about every part the failure stopped: it names the
 * stream or file it stopped, not the part that failed.
 */
const AFTERMATH =
  /Task finished with error code|Terminating thread with return code|Nothing was written into output file|Error submitting a packet to the muxer|Could not open encoder before EOF|Error while filtering|Error sending frames to consumers|Conversion failed/u;

const gpuSteps = (pipeline: VideoPipeline): ReadonlyArray<number> =>
  pipeline.steps.flatMap((step, index) => (step.on === "cpu" ? [] : [index]));

const named = (suspects: ReadonlyArray<number>): Attribution =>
  Attribution.Video({ named: true, suspects: [...new Set(suspects)] });

const tagsOf = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(TAG)].map((match) => match[1] ?? "");

/** What a line says ended the run wherever it stands: a full disk or a stop, or undefined. */
const settledBy = (line: string): NotVideo | undefined => {
  if (DISK_FULL.test(line)) return "disk";

  if (ENDED_BY_SIGNAL.test(line)) return "stopped";

  return undefined;
};

/** Which part other than the video a line says failed, or undefined: the audio, input, or muxer. */
const notVideoOf = (line: string): NotVideo | undefined => {
  if (line.startsWith("Error opening input file")) return "input";
  const tags = tagsOf(line);
  const stream = tags.length > 1 ? tags[0] : undefined;
  const audio = stream?.startsWith("aist#") === true || stream?.startsWith("aost#") === true;

  for (const tag of tags.toReversed()) {
    if (
      audio ||
      AUDIO_FILTERS.test(tag) ||
      tag.startsWith("aist#") ||
      tag.startsWith("aost#") ||
      tag.startsWith("af#")
    ) {
      return "audio";
    }

    if (DEMUXERS.test(tag)) return "input";

    if (MUXERS.test(tag)) return "mux";
  }

  return undefined;
};

/** What one tag says of the video, or undefined when it names nothing this run owns. */
const ofTag = (
  tag: string,
  pipeline: VideoPipeline,
  owners: LogOwners,
): Attribution | undefined => {
  const filter = owners.filters.get(tag);

  if (filter !== undefined) return named(filter);

  // Any other parsed name, of the audio graph or of another run, says nothing about this one.
  if (tag.startsWith("Parsed_")) return undefined;
  const role = /^(dec|enc):(.+)$/u.exec(tag);
  const name = role?.[2] ?? tag;

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

  return undefined;
};

/** Which video steps one line of standard error names, or undefined when it names none. */
const ofLine = (
  line: string,
  pipeline: VideoPipeline,
  owners: LogOwners,
): Attribution | undefined => {
  if (/^Device creation failed|for option 'init_hw_device'/u.test(line)) {
    return named(gpuSteps(pipeline));
  }

  for (const tag of tagsOf(line).toReversed()) {
    const said = ofTag(tag, pipeline, owners);

    if (said !== undefined) return said;
  }

  return undefined;
};

/**
 * What a failed run of `pipeline` points at: a signal that stopped it; a stop or a full disk its
 * log reports anywhere; else the line that ended the run, the last that names a part other than
 * the video or a video step, past what ffmpeg writes after any failure; or, with nothing named,
 * every step outside the CPU.
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

  const lines = failure.stderrTail.split("\n");

  for (const line of lines) {
    const reason = settledBy(line);

    if (reason !== undefined) return Attribution.NotVideo({ reason });
  }

  for (const line of lines.toReversed()) {
    if (!AFTERMATH.test(line)) {
      const reason = notVideoOf(line);

      if (reason !== undefined) return Attribution.NotVideo({ reason });
      const said = ofLine(line, pipeline, owners);

      if (said !== undefined) return said;
    }
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
  /**
   * The source is the cause, and it is kept from these rows: every suspect ran on generated
   * frames, or one failed again only on the source itself.
   */
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
 * there; a run whose ffmpeg never started gives up at once. Exclusions only grow.
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
    // ffmpeg that could not start fails the same under any plan.
    NotVideo: ({ reason }) => (reason === "spawn" ? Recovery.GiveUp() : toCpu),
    Unexplained: () => toCpu,
  });
};
