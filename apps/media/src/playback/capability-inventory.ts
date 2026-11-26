/**
 * What this ffmpeg build does on this machine's devices, kept as evidence per capability key. A
 * key is `unknown` until evidence says `verified` or `unsupported`, and this module is the only
 * place that writes it. Every write carries the epoch its gathering began under and is dropped
 * when the key's epoch moved on since: a quarantine moves one key's epoch, and an identity change
 * moves every epoch of its domain, even of keys with no entry yet. Evidence from a real source
 * belongs to that file version and stream alone and never changes a shared status or sets a shared
 * key aside; a quarantine sets a key aside for a while after a generated clip reproduced a
 * failure or a probe crashed ffmpeg, and a key with strikes needs more clean runs to verify again
 * (`runsToVerify`); an exclusion keeps one source from a row. Pure: the service owns probes and
 * the clock.
 */
import type { MediaFileId } from "@media/contracts/ids";
import { Brand, Data, Option } from "effect";

import { type CapabilitySnapshot, type DomainBinding, rowOf } from "./video-pipeline.ts";
import {
  type BuildFeature,
  type CapabilityKey,
  type Domain,
  type GpuDomain,
  type ImplId,
  implOf,
} from "./video-ops.ts";

/** What evidence says about a key. */
type Status = "unknown" | "verified" | "unsupported";

/**
 * How a probe ended: its output frames came out (`passed`), ffmpeg refused it (`rejected`), a
 * signal such as SIGSEGV or SIGBUS killed ffmpeg as the stage ran (`crashed`), or it proved
 * nothing, as when it timed out, was stopped, or its device would not open.
 */
export type ProbeOutcome = "passed" | "rejected" | "crashed" | "inconclusive";

/** A file version and one of its streams, which real-source evidence belongs to. */
export type SourceScope = string & Brand.Brand<"SourceScope">;

const scopeOf = Brand.nominal<SourceScope>();

/** The scope of stream `stream` of `fileId` as it is on disk now. */
export const sourceScope = (
  fileId: MediaFileId,
  sizeBytes: number,
  modifiedAtMs: number,
  stream: number,
): SourceScope =>
  scopeOf(`${fileId}@${String(sizeBytes)}:${String(modifiedAtMs)}#${String(stream)}`);

/** One observation about a key. */
export type Evidence = Data.TaggedEnum<{
  /** A build listing showed a component the key needs present or absent. */
  Build: { readonly at: number; readonly feature: BuildFeature; readonly present: boolean };
  /** A probe ran, on a generated clip or a real source. */
  Probe: {
    readonly at: number;
    readonly outcome: ProbeOutcome;
    /** The real source it read, whose evidence it is alone; none for a generated clip. */
    readonly source: SourceScope | undefined;
    /** A scrubbed line from ffmpeg's output. */
    readonly detail: string;
    readonly millis: number;
  };
}>;

/** Constructors and matchers for `Evidence`. */
export const Evidence = Data.taggedEnum<Evidence>();

/** A key set aside after a failure the probes reproduced, or a probe that crashed. */
interface Quarantine {
  /** When it ends: 15 minutes, then 2 hours, then not before a restart. */
  readonly until: number | "restart";
  readonly strikes: number;
  readonly since: number;
}

/** Everything known about one key. */
export interface Capability {
  readonly key: CapabilityKey;
  readonly status: Status;
  readonly epoch: number;
  /** Newest first, at most four. */
  readonly evidence: ReadonlyArray<Evidence>;
  readonly quarantine: Option.Option<Quarantine>;
  /** No probe before this time, after inconclusive ones. */
  readonly retryAt: number;
  /** Inconclusive probes in a row. */
  readonly inconclusive: number;
}

/** A GPU device as the service found it. */
export interface DeviceIdentity {
  readonly domain: GpuDomain;
  /** Its render node. */
  readonly node: string;
  /** Whether ffmpeg opened it. */
  readonly opened: boolean;
  /** PCI vendor, device, and revision, such as `8086:56a5 rev 05`. */
  readonly pci: string | undefined;
  /** The kernel driver bound to it, such as `i915`. */
  readonly kernelDriver: string | undefined;
  /** The userspace driver ffmpeg loaded, such as Intel's iHD driver and its version. */
  readonly userDriver: string | undefined;
  readonly at: number;
}

/** The ffmpeg build: its version line and the components its listings show. */
export interface BuildIdentity {
  readonly version: string;
  readonly kernel: string;
  readonly features: ReadonlySet<BuildFeature>;
  readonly at: number;
}

/** What the service knows. */
export interface Inventory {
  readonly build: Option.Option<BuildIdentity>;
  readonly devices: ReadonlyMap<GpuDomain, DeviceIdentity>;
  readonly capabilities: ReadonlyMap<CapabilityKey, Capability>;
  /** Real-source evidence, by the file version and stream it came from. */
  readonly sources: ReadonlyMap<SourceScope, ReadonlyMap<CapabilityKey, Capability>>;
  /** Rows a source must not use, until a time. */
  readonly exclusions: ReadonlyMap<SourceScope, ReadonlyMap<ImplId, number>>;
  /** The newest epoch handed out; a key's epoch only ever moves to a newer one. */
  readonly clock: number;
  /** The epoch of a domain's keys that have no entry yet, which an identity change moves on. */
  readonly floors: ReadonlyMap<Domain, number>;
}

/** An inventory that knows nothing. */
export const empty: Inventory = {
  build: Option.none(),
  devices: new Map(),
  capabilities: new Map(),
  sources: new Map(),
  exclusions: new Map(),
  clock: 0,
  floors: new Map(),
};

const EVIDENCE_KEPT = 4;

const RETRY_FIRST_MS = 30_000;

const RETRY_MOST_MS = 3_600_000;

const QUARANTINE_MS: ReadonlyArray<number> = [15 * 60_000, 2 * 3_600_000];

/** How long a source stays off a row a failure of it pointed at. */
const SOURCE_EXCLUSION_MS = 24 * 3_600_000;

const unknown = (key: CapabilityKey, epoch: number): Capability => ({
  key,
  status: "unknown",
  epoch,
  evidence: [],
  quarantine: Option.none(),
  retryAt: 0,
  inconclusive: 0,
});

/** The domain `key`'s row runs in. */
const domainOf = (key: CapabilityKey): Domain => rowOf(implOf(key))?.on ?? "cpu";

/** What is known about `key`, from a source's own evidence when `scope` has some. */
export const capabilityOf = (
  inventory: Inventory,
  key: CapabilityKey,
  scope?: SourceScope,
): Capability =>
  (scope === undefined ? undefined : inventory.sources.get(scope)?.get(key)) ??
  inventory.capabilities.get(key) ??
  unknown(key, inventory.floors.get(domainOf(key)) ?? 0);

/** Whether `capability` is set aside at `now`. */
export const isQuarantined = (capability: Capability, now: number): boolean =>
  Option.match(capability.quarantine, {
    onNone: () => false,
    onSome: ({ until }) => until === "restart" || until > now,
  });

/**
 * How many clean runs in a row a probe of `key` needs before it verifies the key: the probe's own
 * `runs`, three times over for each strike the key has taken. Strikes stay after a quarantine
 * ends, since a key that crashed in a share of runs can pass a few by luck: on an Arc A380,
 * VA-API's MPEG-2 decoder probe crashed in 46 of 108 runs and passed three in a row a fifth of the
 * time.
 */
export const runsToVerify = (inventory: Inventory, key: CapabilityKey, runs: number): number =>
  runs *
  3 **
    Option.match(capabilityOf(inventory, key).quarantine, {
      onNone: () => 0,
      onSome: ({ strikes }) => strikes,
    });

/** What a probe makes a key's status; a crash sets the key aside instead (`setAside`). */
const PROBE_STATUS: Readonly<Record<ProbeOutcome, Status | undefined>> = {
  passed: "verified",
  rejected: "unsupported",
  crashed: undefined,
  inconclusive: undefined,
};

const statusAfter = (capability: Capability, evidence: Evidence): Status =>
  Evidence.$match(evidence, {
    Build: ({ present }) =>
      !present ? "unsupported" : capability.status === "unknown" ? "verified" : capability.status,
    Probe: ({ outcome }) => PROBE_STATUS[outcome] ?? capability.status,
  });

const updated = (capability: Capability, evidence: Evidence): Capability => {
  const inconclusive =
    Evidence.$is("Probe")(evidence) && evidence.outcome === "inconclusive"
      ? capability.inconclusive + 1
      : 0;

  return {
    ...capability,
    status: statusAfter(capability, evidence),
    evidence: [evidence, ...capability.evidence].slice(0, EVIDENCE_KEPT),
    inconclusive,
    retryAt:
      inconclusive === 0
        ? 0
        : evidence.at + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** (inconclusive - 1)),
  };
};

/** Whether `epoch`, which a write's gathering began under, is still `key`'s. */
const current = (inventory: Inventory, key: CapabilityKey, epoch: number): boolean =>
  capabilityOf(inventory, key).epoch === epoch;

/** Keeps `scope` from the rows `impls` until `until`. */
const exclude = (
  inventory: Inventory,
  scope: SourceScope,
  impls: Iterable<ImplId>,
  until: number,
): Inventory => {
  const known = new Map(inventory.exclusions.get(scope) ?? []);

  for (const impl of impls) known.set(impl, Math.max(until, known.get(impl) ?? 0));

  return { ...inventory, exclusions: new Map(inventory.exclusions).set(scope, known) };
};

/**
 * Quarantines `key` at `at`: 15 minutes at the first strike, 2 hours at the second, then until a
 * restart. Its status returns to `unknown`, every source's own evidence for it goes, and its epoch
 * moves on, so nothing that started earlier is recorded. A key already set aside takes no strike,
 * as failures of one outage are one.
 */
const setAside = (inventory: Inventory, key: CapabilityKey, at: number): Inventory => {
  const capability = capabilityOf(inventory, key);

  if (isQuarantined(capability, at)) return inventory;

  const strikes = Option.match(capability.quarantine, {
    onNone: () => 1,
    onSome: (q) => q.strikes + 1,
  });

  const span = QUARANTINE_MS[strikes - 1];
  const next = inventory.clock + 1;

  return {
    ...inventory,
    clock: next,
    sources: new Map(
      [...inventory.sources].map(([scope, known]) => [
        scope,
        new Map([...known].filter(([sourceKey]) => sourceKey !== key)),
      ]),
    ),
    capabilities: new Map(inventory.capabilities).set(key, {
      ...capability,
      status: "unknown",
      epoch: next,
      quarantine: Option.some({
        until: span === undefined ? "restart" : at + span,
        strikes,
        since: at,
      }),
      retryAt: 0,
      inconclusive: 0,
    }),
  };
};

/**
 * Records `evidence` for `key` if `epoch` is still the key's; otherwise a quarantine or an
 * identity change came since, and it is dropped. A probe of a real source goes under that source
 * and never changes the shared status. A probe that crashed counts as a failure the probes
 * reproduced (`reproduced`): a generated clip's quarantines the key, a real source's keeps that
 * source off the row, and the probe's evidence is kept either way.
 */
export const record = (
  inventory: Inventory,
  key: CapabilityKey,
  evidence: Evidence,
  epoch: number,
): Inventory => {
  if (!current(inventory, key, epoch)) return inventory;

  const probe = Evidence.$is("Probe")(evidence) ? evidence : undefined;
  const source = probe?.source;

  if (source === undefined) {
    const recorded: Inventory = {
      ...inventory,
      capabilities: new Map(inventory.capabilities).set(
        key,
        updated(capabilityOf(inventory, key), evidence),
      ),
    };

    return probe?.outcome === "crashed" ? setAside(recorded, key, probe.at) : recorded;
  }

  const known = inventory.sources.get(source) ?? new Map<CapabilityKey, Capability>();

  const recorded: Inventory = {
    ...inventory,
    sources: new Map(inventory.sources).set(
      source,
      new Map(known).set(key, updated(known.get(key) ?? unknown(key, epoch), evidence)),
    ),
  };

  return probe?.outcome === "crashed"
    ? exclude(recorded, source, [implOf(key)], probe.at + SOURCE_EXCLUSION_MS)
    : recorded;
};

/**
 * Records that `probe`, re-probing `key` after a failed run, failed again, if `epoch`, the key's
 * when the diagnosis began, is still its. On a generated clip that quarantines the key
 * (`setAside`) and keeps the probe as its newest evidence, so what is known shows why. On the real
 * source the probe read it says nothing about other files: that source alone keeps off the row.
 */
export const reproduced = (
  inventory: Inventory,
  key: CapabilityKey,
  probe: Extract<Evidence, { readonly _tag: "Probe" }>,
  epoch: number,
): Inventory => {
  if (!current(inventory, key, epoch)) return inventory;

  if (probe.source !== undefined) {
    return exclude(inventory, probe.source, [implOf(key)], probe.at + SOURCE_EXCLUSION_MS);
  }

  const capability = capabilityOf(inventory, key);

  if (isQuarantined(capability, probe.at)) return inventory;

  const shown: Inventory = {
    ...inventory,
    capabilities: new Map(inventory.capabilities).set(key, {
      ...capability,
      evidence: [probe, ...capability.evidence].slice(0, EVIDENCE_KEPT),
    }),
  };

  return setAside(shown, key, probe.at);
};

/**
 * Records that `key` ran on generated frames although a run of `source` failed on it, if `epoch`
 * is still the key's: the failure belongs to that source, which keeps off the row for a day.
 */
export const notReproduced = (
  inventory: Inventory,
  key: CapabilityKey,
  source: SourceScope,
  at: number,
  epoch: number,
): Inventory =>
  current(inventory, key, epoch)
    ? exclude(inventory, source, [implOf(key)], at + SOURCE_EXCLUSION_MS)
    : inventory;

/**
 * Forgets what is known about `domain`'s keys, as after its device changed, and moves every one of
 * their epochs on, those of keys with no entry yet included, so no probe that began before counts.
 * Quarantines stay.
 */
export const forget = (inventory: Inventory, domain: Domain): Inventory => {
  const next = inventory.clock + 1;
  const affected = (key: CapabilityKey) => domainOf(key) === domain;

  return {
    ...inventory,
    clock: next,
    floors: new Map(inventory.floors).set(domain, next),
    capabilities: new Map(
      [...inventory.capabilities].map(([key, capability]) =>
        affected(key)
          ? [key, { ...unknown(key, next), quarantine: capability.quarantine }]
          : [key, capability],
      ),
    ),
    sources: new Map(
      [...inventory.sources].map(([scope, known]) => [
        scope,
        new Map([...known].filter(([key]) => !affected(key))),
      ]),
    ),
  };
};

/** Records the build's identity. */
export const withBuild = (inventory: Inventory, build: BuildIdentity): Inventory => ({
  ...inventory,
  build: Option.some(build),
});

/** Records what the service found of a device. */
export const withDevice = (inventory: Inventory, device: DeviceIdentity): Inventory => ({
  ...inventory,
  devices: new Map(inventory.devices).set(device.domain, device),
});

/** Keys quarantined at or after `since`. */
export const quarantinedSince = (
  inventory: Inventory,
  since: number,
): ReadonlyArray<CapabilityKey> =>
  [...inventory.capabilities.values()].flatMap((capability) =>
    Option.match(capability.quarantine, {
      onNone: () => [],
      onSome: (q) => (q.since >= since ? [capability.key] : []),
    }),
  );

/** Whether a probe of `key` may run at `now`: it is unknown, not set aside, and past its backoff. */
export const probeable = (
  inventory: Inventory,
  key: CapabilityKey,
  now: number,
  scope?: SourceScope,
): boolean => {
  const capability = capabilityOf(inventory, key, scope);

  return (
    capability.status === "unknown" &&
    !isQuarantined(capabilityOf(inventory, key), now) &&
    now >= capability.retryAt
  );
};

/**
 * What planning may use for `scope` at `now`, or for no source in particular: keys verified and
 * not set aside, with this source's own evidence over the shared one, on the bound `domains`,
 * without the rows this source or this session (`excluded`) must not use.
 */
export const snapshot = (
  inventory: Inventory,
  scope: SourceScope | undefined,
  now: number,
  domains: ReadonlyArray<DomainBinding>,
  excluded: ReadonlySet<ImplId>,
): CapabilitySnapshot => {
  const own =
    (scope === undefined ? undefined : inventory.sources.get(scope)) ??
    new Map<CapabilityKey, Capability>();

  const keys = new Set([...inventory.capabilities.keys(), ...own.keys()]);

  const verified = [...keys].filter(
    (key) =>
      capabilityOf(inventory, key, scope).status === "verified" &&
      !isQuarantined(capabilityOf(inventory, key), now),
  );

  const excludedHere = [
    ...((scope === undefined ? undefined : inventory.exclusions.get(scope)) ?? []),
  ].flatMap(([impl, until]) => (until > now ? [impl] : []));

  return {
    domains,
    verified: new Set(verified),
    excluded: new Set([...excluded, ...excludedHere]),
  };
};
