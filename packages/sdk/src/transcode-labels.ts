import type { TranscodeReason, TranscodeStage } from "@media/contracts/media-playback";

const DOMAINS: ReadonlyMap<string, string> = new Map([
  ["cpu", "CPU"],
  ["qsv", "QSV"],
  ["vaapi", "VA-API"],
]);

/** `CPU`, `QSV`, `VA-API`, or a later backend's domain upper-cased. */
export const domainLabel = (domain: string): string => DOMAINS.get(domain) ?? domain.toUpperCase();

const OPS: ReadonlyMap<string, string> = new Map([
  ["decode", "Decode"],
  ["scale", "Scale"],
  ["tonemap", "Tone map"],
  ["burn-image", "Subtitle"],
  ["encode", "Encode"],
  ["move", "Move"],
]);

/** `Decode`, `Tone map`, `Subtitle` for a burned-in picture subtitle, or a later operation as named. */
export const opLabel = (op: string): string => OPS.get(op) ?? op;

/** One stage in a few words: `Decode · QSV`, or a move: `Move · QSV → CPU`. */
export const stageLabel = (stage: TranscodeStage): string =>
  stage.move === undefined
    ? `${opLabel(stage.op)} · ${domainLabel(stage.domain)}`
    : `${opLabel(stage.op)} · ${domainLabel(stage.move.from)} → ${domainLabel(stage.move.to)}`;

const CAUSES: ReadonlyMap<string, string> = new Map([
  ["capability", "stage failed"],
  ["source", "file failed"],
  ["undecided", "unproven"],
  ["not-video", "not the video"],
  ["unexplained", "unexplained"],
  ["capability-lost", "stage lost"],
]);

/** A change's cause in a few words, such as `stage failed`, or the code itself when new. */
export const causeLabel = (cause: string): string => CAUSES.get(cause) ?? cause;

const REASONS: Readonly<Record<TranscodeReason, string>> = {
  reproduced: "probe failed too",
  "file-only": "this file only",
  undecided: "probes timed out",
  unexplained: "unexplained",
  stopped: "stopped",
  "not-started": "didn't start",
  "disk-full": "disk full",
  input: "input failed",
  audio: "audio failed",
  mux: "output failed",
  "capability-lost": "stage lost",
  "nothing-left": "nothing left to try",
  "segment-not-cut": "segment not cut",
  other: "failed",
};

/** Why a chain changed or a stream ended, in a few words, such as `disk full`. */
export const reasonLabel = (reason: TranscodeReason): string => REASONS[reason];

/** A GPU device as a server's transcoding report lists it. */
interface ReportedDevice {
  readonly domain: string;
  readonly node: string;
  readonly opened: boolean;
  readonly pci: string | null;
  readonly kernelDriver: string | null;
  readonly userDriver: string | null;
}

/** One GPU, which a report lists once per GPU API. */
export interface DeviceSummary {
  /** Its render node's name, such as `renderD128`. */
  readonly node: string;
  /** Its PCI id, else its node, and its kernel driver: `8086:56a5 rev 05 · i915`. */
  readonly label: string;
  /** The GPU APIs ffmpeg opened it through, such as `QSV` and `VA-API`; none when none did. */
  readonly apis: ReadonlyArray<string>;
  /** The userspace driver ffmpeg loaded, when one opened it. */
  readonly driver: string | null;
}

/** The GPUs a report lists, one per render node, in the order the report first names them. */
export const devicesOf = (devices: ReadonlyArray<ReportedDevice>): ReadonlyArray<DeviceSummary> => {
  const nodes: Array<string> = [];

  for (const device of devices) if (!nodes.includes(device.node)) nodes.push(device.node);

  return nodes.map((node) => {
    const views = devices.filter((device) => device.node === node);
    const opened = views.filter((device) => device.opened);
    const first = views[0];

    return {
      node,
      label: [first?.pci ?? node, first?.kernelDriver ?? null]
        .filter((part) => part !== null)
        .join(" · "),
      apis: opened.map((device) => domainLabel(device.domain)),
      driver: opened.find((device) => device.userDriver !== null)?.userDriver ?? null,
    };
  });
};

/** A capability as a server's transcoding report lists it. */
interface ReportedCapability {
  readonly key: string;
  readonly status: "unknown" | "verified" | "unsupported";
  readonly quarantineEndsAt: number | "restart" | null;
}

/** A capability set aside now, and until when: a time, or `restart`. */
interface Quarantined {
  readonly key: string;
  readonly endsAt: number | "restart";
}

/** What a report's capabilities say in short. */
export interface CapabilityCounts {
  readonly verified: number;
  readonly unsupported: number;
  readonly unknown: number;
  /** The capabilities whose quarantine is still in force, in the report's order. */
  readonly quarantined: ReadonlyArray<Quarantined>;
}

/** How many capabilities are verified, unsupported, and unknown, and which are quarantined at `now`. */
export const capabilityCounts = (
  capabilities: ReadonlyArray<ReportedCapability>,
  now: number,
): CapabilityCounts => ({
  verified: capabilities.filter((capability) => capability.status === "verified").length,
  unsupported: capabilities.filter((capability) => capability.status === "unsupported").length,
  unknown: capabilities.filter((capability) => capability.status === "unknown").length,
  quarantined: capabilities.flatMap(({ key, quarantineEndsAt }) =>
    quarantineEndsAt === "restart" || (quarantineEndsAt !== null && quarantineEndsAt > now)
      ? [{ key, endsAt: quarantineEndsAt }]
      : [],
  ),
});
