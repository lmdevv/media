/**
 * What the media service tells players and admins about its transcoder: a generation's stages and
 * the changes that led to them (`summaryOf`), the video a generation delivers (`deliveredVideo`),
 * and the ffmpeg build, devices, and evidence per capability (`transcodingReport`). Each is a
 * projection of what the service keeps; none carries ffmpeg arguments, file paths, or a render
 * node's folder, and every line from ffmpeg's log passes through `scrubLine` first.
 */
import type { DeliveredVideo, TranscodeSummary } from "@media/contracts/media-playback";
import type { TranscodingReport } from "@media/contracts/server-functions";
import { EpochMillis } from "@media/contracts/units";
import { Option } from "effect";

import type { VideoStream } from "../media/media-probe.ts";
import {
  type Capability,
  Evidence,
  type Inventory,
  isQuarantined,
} from "./capability-inventory.ts";
import { VideoPlan } from "./playback-decision.ts";
import { rowOf, type Step } from "./video-pipeline.ts";
import { implOf, Op } from "./video-ops.ts";

/** The longest line a summary or report carries from ffmpeg's log. */
const LINE_MAX = 200;

/** Where a path stood in a scrubbed line. */
const PATH = "<path>";

/** A path in quotes: everything between the quotes goes. */
const QUOTED_PATH = /(["'])\/[^"']*\1/gu;

/**
 * A path outside whole quotes, from its first slash to the end of the line: a folder name may
 * hold spaces or `: `, and a line cut short may leave a quote open, so nothing after the slash is
 * safe to keep. A slash starts a path only at the start of the line or after a space, a quote, or
 * one of `=([,:`, so `h264/yuv420p` and `1/25` stay.
 */
const BARE_PATH = /(^|[\s"'=([,:])\/.*$/u;

const CREDENTIAL = /\b(token|ticket)=[^\s&"']+/giu;

const CONTROL = /\p{Cc}+/gu;

/**
 * One line of ffmpeg's log as the wire may carry it: its first line, without control characters,
 * any absolute path, or a token or ticket, folded and cut to 200 characters.
 */
export const scrubLine = (text: string): string =>
  (text.trim().split("\n")[0] ?? "")
    .replaceAll(CONTROL, " ")
    .replaceAll(QUOTED_PATH, PATH)
    .replace(BARE_PATH, `$1${PATH}`)
    .replaceAll(CREDENTIAL, "$1=<redacted>")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, LINE_MAX);

/** What an operation is called on the wire, after its rows' names (`tonemap.qsv`). */
const opName = (op: Op): string =>
  Op.$match(op, {
    Decode: () => "decode",
    Scale: () => "scale",
    ToneMap: () => "tonemap",
    BurnImage: () => "burn-image",
    Encode: () => "encode",
    Move: () => "move",
  });

type Stage = TranscodeSummary["stages"][number];

const stageOf = (step: Step): Stage => {
  const op = opName(step.op);

  if (!Op.$is("Move")(step.op)) return { op, domain: step.on, impl: step.impl };

  return {
    op,
    domain: step.on,
    impl: step.impl,
    move: { from: step.input.memory, to: step.output.memory },
  };
};

/** A change of a stream's chain as the stream keeps it. */
interface ChangeRecord {
  readonly at: number;
  readonly generation: number;
  /** A diagnosis's tag, such as `NotVideo`, or `capability-lost`. */
  readonly cause: string;
  readonly excluded: ReadonlyArray<string>;
  readonly detail: string;
}

/** `NotVideo` → `not-video`: a cause as the wire's code. */
const causeCode = (cause: string): string =>
  cause.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, "-").toLowerCase();

/**
 * The summary of generation `generation`, which runs `video`: its stages in order, moves included,
 * none for a copy, and the changes up to it, oldest first.
 */
export const summaryOf = (
  video: VideoPlan,
  changes: ReadonlyArray<ChangeRecord>,
  generation: number,
): TranscodeSummary => ({
  stages: VideoPlan.$match(video, {
    Copy: () => [],
    Encode: ({ pipeline }) => pipeline.steps.map(stageOf),
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
            detail: scrubLine(change.detail),
          },
        ],
  ),
});

/** The video a plan delivers from `source`: the source itself when copied, else the encode's. */
export const deliveredVideo = (video: VideoPlan, source: VideoStream): DeliveredVideo =>
  VideoPlan.$match(video, {
    Copy: () => ({
      codec: source.codec,
      width: source.width,
      height: source.height,
      dynamicRange: source.dynamicRange,
    }),
    Encode: ({ output }) => ({
      codec: output.codec,
      width: output.width,
      height: output.height,
      dynamicRange: output.dynamicRange,
    }),
  });

/** `ffmpeg version 9.0.2 Copyright …` → `9.0.2`. */
const versionOf = (line: string): string =>
  /^ffmpeg version (\S+)/u.exec(line)?.[1] ?? scrubLine(line);

const basename = (node: string): string => node.slice(node.lastIndexOf("/") + 1);

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const evidenceOf = (
  capability: Capability,
): Pick<TranscodingReport["capabilities"][number], "source" | "checkedAt" | "detail"> => {
  const latest = capability.evidence[0];

  if (latest === undefined) return { source: null, checkedAt: null, detail: "" };

  return Evidence.$match(latest, {
    Build: ({ at, feature, present }) => ({
      source: "listing" as const,
      checkedAt: EpochMillis.make(at),
      detail: `${present ? "lists" : "lacks"} ${feature}`,
    }),
    Probe: ({ at, outcome, detail }) => {
      const line = scrubLine(detail);

      return {
        source: "probe" as const,
        checkedAt: EpochMillis.make(at),
        detail: line === "" ? outcome : `${outcome}: ${line}`,
      };
    },
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
      kernel: scrubLine(build.kernel),
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
      userDriver: device.userDriver === undefined ? null : scrubLine(device.userDriver),
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
        detail: evidence.detail,
        quarantineEndsAt: quarantineEndOf(capability, now),
      };
    }),
});
