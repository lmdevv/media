/**
 * What the media service tells players and admins about its transcoder: a generation's stages and
 * the changes that led to them (`summaryOf`), the video a generation delivers (`deliveredVideo`),
 * and the ffmpeg build, devices, and evidence per capability (`transcodingReport`). Each is a
 * projection of what the service keeps into codes, implementation ids, and device identities: no
 * text from ffmpeg's log reaches the wire, only the codes its classifiers chose (`reasonOf`) and a
 * driver's name and version matched whole.
 */
import type {
  DeliveredVideo,
  TranscodeReason,
  TranscodeSummary,
} from "@media/contracts/media-playback";
import type { EvidenceReason, TranscodingReport } from "@media/contracts/server-functions";
import { dolbyVisionBase } from "@media/contracts/direct-play";
import { EpochMillis } from "@media/contracts/units";
import { Option, type Types } from "effect";

import type { VideoStream } from "../media/media-probe.ts";
import {
  type Capability,
  Evidence,
  type Inventory,
  isQuarantined,
  type ProbeOutcome,
} from "./capability-inventory.ts";
import { VideoPlan } from "./playback-decision.ts";
import { kindOf } from "./source-colours.ts";
import { Diagnosis } from "./transcode-recovery.ts";
import { type Instead, rowOf, type Step } from "./video-pipeline.ts";
import { implOf, Op } from "./video-ops.ts";

/** What a failure that was not the video's points at, as the recovery classifier names it. */
type NotVideoPart = Extract<Diagnosis, { readonly _tag: "NotVideo" }>["reason"];

const NOT_VIDEO_REASONS = {
  stopped: "stopped",
  spawn: "not-started",
  disk: "disk-full",
  input: "input",
  audio: "audio",
  mux: "mux",
} as const satisfies Record<NotVideoPart, TranscodeReason>;

/** What a diagnosis of a failed run found, as the wire's code. */
export const reasonOf = (diagnosis: Diagnosis): TranscodeReason =>
  Diagnosis.$match(diagnosis, {
    Capability: (): TranscodeReason => "reproduced",
    Source: (): TranscodeReason => "file-only",
    Undecided: (): TranscodeReason => "undecided",
    NotVideo: ({ reason }): TranscodeReason => NOT_VIDEO_REASONS[reason],
    Unexplained: (): TranscodeReason => "unexplained",
  });

/** What an operation is called on the wire, after its rows' names (`tonemap.qsv`). */
const opName = (op: Op): string =>
  Op.$match(op, {
    Decode: () => "decode",
    Deinterlace: () => "deinterlace",
    Scale: () => "scale",
    ToneMap: () => "tonemap",
    BurnImage: () => "burn-image",
    BurnText: () => "burn-text",
    Encode: () => "encode",
    Move: () => "move",
  });

type Stage = TranscodeSummary["stages"][number];

/**
 * Where a step's frames came from and went: a move's memories; for a row that takes its frames
 * elsewhere and back (`Row.transfers`), their memory and that device, as libplacebo's tone map
 * uploads to Vulkan; for an overlay on a GPU, the CPU memory its image subtitle was decoded and
 * scaled in and the device it was drawn on, while the picture stayed there; none for any other step.
 */
const movedBy = (step: Step): Stage["move"] => {
  if (Op.$is("Move")(step.op)) return { from: step.input.memory, to: step.output.memory };
  const transfers = rowOf(step.impl)?.transfers;

  if (transfers !== undefined) return { from: step.input.memory, to: transfers.device };

  if (Op.$is("BurnImage")(step.op) && step.op.subtitle.frame.memory !== step.on) {
    return { from: step.op.subtitle.frame.memory, to: step.on };
  }

  return undefined;
};

/** `step`, the `index`th of its chain, as a stage, with why it runs a fallback row (`instead`). */
const stageOf = (step: Step, index: number, instead: ReadonlyArray<Instead>): Stage => {
  const stage: Types.Mutable<Stage> = { op: opName(step.op), domain: step.on, impl: step.impl };
  const move = movedBy(step);
  const why = instead.find((entry) => entry.step === index);

  if (move !== undefined) stage.move = move;

  if (why !== undefined) stage.insteadOf = { impl: why.of, reason: why.reason };

  return stage;
};

/** A change of a stream's chain as the stream keeps it. */
interface ChangeRecord {
  readonly at: number;
  readonly generation: number;
  /** A diagnosis's tag, such as `NotVideo`, or `capability-lost`. */
  readonly cause: string;
  readonly excluded: ReadonlyArray<string>;
  readonly reason: TranscodeReason;
}

/** `NotVideo` → `not-video`: a cause as the wire's code. */
const causeCode = (cause: string): string =>
  cause.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, "-").toLowerCase();

/**
 * The summary of generation `generation`, which runs `video` from `source`: the source's kind of
 * colour, the stages in order, moves included, none for a copy, and the changes up to it, oldest
 * first.
 */
export const summaryOf = (
  video: VideoPlan,
  changes: ReadonlyArray<ChangeRecord>,
  generation: number,
  source: VideoStream | undefined,
): TranscodeSummary => ({
  ...Option.match(Option.fromUndefinedOr(source), {
    onNone: () => ({}),
    onSome: (stream) => ({ source: kindOf(stream) }),
  }),
  stages: VideoPlan.$match(video, {
    Copy: () => [],
    Encode: ({ pipeline, instead }) =>
      pipeline.steps.map((step, index) => stageOf(step, index, instead)),
  }),
  changes: changes.flatMap((change) =>
    change.generation > generation
      ? []
      : [
          {
            at: EpochMillis.make(change.at),
            generation: change.generation,
            cause: causeCode(change.cause),
            excluded: [...change.excluded],
            reason: change.reason,
          },
        ],
  ),
});

/**
 * The video a plan delivers from `source`: the source itself when copied, in the range the copy
 * delivers (a Dolby Vision copy without its record is its base layer), else the encode's.
 */
export const deliveredVideo = (video: VideoPlan, source: VideoStream): DeliveredVideo =>
  VideoPlan.$match(video, {
    Copy: ({ dolbyVision }) => ({
      codec: source.codec,
      width: source.width,
      height: source.height,
      dynamicRange:
        dolbyVision === "base"
          ? (dolbyVisionBase(source) ?? source.dynamicRange)
          : source.dynamicRange,
    }),
    Encode: ({ output }) => ({
      codec: output.codec,
      width: output.width,
      height: output.height,
      dynamicRange: output.dynamicRange,
    }),
  });

/**
 * The most characters ffmpeg's version or a driver's name and version takes in the report. Both
 * are what the tools say of themselves; the cap keeps a malformed line from filling the report.
 */
const IDENTITY_CHARS_MAX = 64;

/** `text`, or null when it is longer than the report takes. */
const bounded = (text: string): string | null => (text.length <= IDENTITY_CHARS_MAX ? text : null);

/** ffmpeg's version line, whose version is a token of letters, digits, and `.+~-`. */
const VERSION = /^ffmpeg version ([\w.+~-]+)(?:\s|$)/u;

/**
 * `ffmpeg version 9.0.2 Copyright …` → `9.0.2`; null for a line in any other form or a version
 * past the cap.
 */
const versionOf = (line: string): string | null => {
  const version = VERSION.exec(line)?.[1];

  return version === undefined ? null : bounded(version);
};

/**
 * A userspace driver as libva names it, `Intel iHD driver for Intel(R) Gen Graphics - 25.2.6`: a
 * name of letters, digits, spaces, parentheses, and `.+-`, then ` - ` and a dotted version.
 */
const DRIVER = /^([A-Za-z][A-Za-z0-9 ().+-]{0,79}?) - (\d{1,4}(?:\.\d{1,4}){0,3})/u;

/**
 * The driver's name and version alone, such as `Intel iHD driver for Intel(R) Gen Graphics
 * 25.2.6`: whatever follows the version stays off the wire, and a driver named in another form,
 * or longer than the cap, is null.
 */
const driverOf = (named: string): string | null => {
  const [, name, version] = DRIVER.exec(named) ?? [];

  return name === undefined || version === undefined ? null : bounded(`${name} ${version}`);
};

const basename = (node: string): string => node.slice(node.lastIndexOf("/") + 1);

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const PROBE_REASONS = {
  passed: "passed",
  rejected: "refused",
  crashed: "crashed",
  inconclusive: "inconclusive",
} as const satisfies Record<ProbeOutcome, EvidenceReason>;

/** What a capability's latest evidence puts in the report. */
type Shown = Pick<TranscodingReport["capabilities"][number], "source" | "checkedAt" | "reason">;

const evidenceOf = (capability: Capability): Shown => {
  const latest = capability.evidence[0];

  if (latest === undefined) return { source: null, checkedAt: null, reason: null };

  return Evidence.$match(latest, {
    Build: ({ at, present }): Shown => ({
      source: "listing",
      checkedAt: EpochMillis.make(at),
      reason: present ? "listed" : "not-listed",
    }),
    Probe: ({ at, outcome }): Shown => ({
      source: "probe",
      checkedAt: EpochMillis.make(at),
      reason: PROBE_REASONS[outcome],
    }),
  });
};

const quarantineEndOf = (
  capability: Capability,
  now: number,
): TranscodingReport["capabilities"][number]["quarantineEndsAt"] =>
  isQuarantined(capability, now)
    ? Option.match(capability.quarantine, {
        onNone: () => null,
        onSome: ({ until }) => (until === "restart" ? "restart" : EpochMillis.make(until)),
      })
    : null;

/**
 * What `inventory` says at `now`, for admins: the build, each device with its render node's name
 * alone, and each shared capability by key with its latest evidence and any quarantine still in
 * force. Evidence from real files stays out, as do the files a failure kept off a row.
 */
export const transcodingReport = (inventory: Inventory, now: number): TranscodingReport => ({
  build: Option.match(inventory.build, {
    onNone: () => null,
    onSome: (build) => ({
      version: versionOf(build.version),
      kernel: build.kernel,
      checkedAt: EpochMillis.make(build.at),
    }),
  }),
  devices: [...inventory.devices.values()]
    .toSorted((left, right) => byText(left.domain, right.domain))
    .map((device) => ({
      domain: device.domain,
      node: basename(device.node),
      opened: device.opened,
      pci: device.pci ?? null,
      kernelDriver: device.kernelDriver ?? null,
      userDriver: device.userDriver === undefined ? null : driverOf(device.userDriver),
      checkedAt: EpochMillis.make(device.at),
    })),
  capabilities: [...inventory.capabilities.values()]
    .toSorted((left, right) => byText(left.key, right.key))
    .map((capability) => {
      const evidence = evidenceOf(capability);

      return {
        key: capability.key,
        domain: rowOf(implOf(capability.key))?.on ?? "cpu",
        status: capability.status,
        source: evidence.source,
        checkedAt: evidence.checkedAt,
        reason: evidence.reason,
        quarantineEndsAt: quarantineEndOf(capability, now),
      };
    }),
});
