/**
 * The capability service: what this ffmpeg build does on this machine, found through real ffmpeg
 * and kept in memory for the life of the process (ADS-388). At start, in the background, it reads
 * the build's listings and each configured GPU device's identity, then probes every generated-clip
 * variant of that device's rows, one at a time at the lowest CPU priority. A negotiation probes
 * the unknown keys its cheapest chain would use under one budget, ahead of that warmup, real
 * sources where no clip stands in, and then plans once from a snapshot. After a failed run it
 * re-probes the suspects: a reproduced failure quarantines that one key, a failure nothing
 * reproduces keeps that source from the rows involved, and running out of time decides nothing.
 * A listing proves the CPU's rows, which touch no device; it never proves a GPU row. A listing
 * that fails is read again at the next need, and the CPU's rows stay unknown meanwhile.
 */
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  type Scope,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as Inventory from "./capability-inventory.ts";
import { PROBE_CLIPS } from "./probe-clips.ts";
import {
  attribute,
  Attribution,
  Diagnosis,
  type LogOwners,
  type RunFailure,
} from "./transcode-recovery.ts";
import {
  candidateKeys,
  type CapabilitySnapshot,
  DOMAINS,
  type DomainBinding,
  GPU_PREFERENCE,
  planVideo,
  ProbeInput,
  type ProbePlan,
  probedSteps,
  probeFor,
  Rejection,
  sourceProbeFor,
  type Step,
  VIDEO_OPS,
  type VideoIntent,
  type VideoPipeline,
} from "./video-pipeline.ts";
import { probeCommandArgs, probedFrames } from "./video-render.ts";
import {
  type BuildFeature,
  type CapabilityKey,
  type ClipName,
  type Domain,
  type GpuDomain,
  type ImplId,
  implOf,
  type SourceVideo,
} from "./video-ops.ts";

/** One source's question: what planning may use for it. */
export interface Request {
  readonly scope: Inventory.SourceScope;
  /** The file, for probes that read it. */
  readonly path: string;
  readonly stream: number;
  readonly source: SourceVideo;
  readonly intent: VideoIntent;
  /** Rows the asking stream keeps off. */
  readonly excluded: ReadonlySet<ImplId>;
}

/** A run that failed, and how its log reads back to its steps. */
export interface FailedRun {
  readonly request: Request;
  readonly pipeline: VideoPipeline;
  readonly owners: LogOwners;
  readonly failure: RunFailure;
}

/** What this ffmpeg build does on this machine. */
export interface Interface {
  /**
   * What planning may use for `request` now, without probing; the build listing settles the
   * CPU's rows at once.
   */
  readonly current: (request: Request) => Effect.Effect<CapabilitySnapshot>;
  /**
   * Probes, within the negotiation budget, the unknown keys the cheapest chain for `request` would
   * use, then answers what planning may use. A key still unknown at the deadline stays out.
   */
  readonly resolve: (request: Request) => Effect.Effect<CapabilitySnapshot>;
  /**
   * Re-probes what a failed run points at, within five seconds, records what that shows, and
   * answers it. A failure that is not about video changes nothing.
   */
  readonly diagnose: (failed: FailedRun) => Effect.Effect<Diagnosis>;
  /** Everything known: the build, the devices, and each key's evidence. */
  readonly inventory: Effect.Effect<Inventory.Inventory>;
  /** The first configured GPU domain with a verified encoder, which new encodes prefer. */
  readonly hardwareEncoder: Effect.Effect<GpuDomain | undefined>;
}

/** The capability service. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/TranscodeCapabilities",
) {}

/** The longest one probe runs before it is killed and proves nothing. */
export const ProbeTimeout = Context.Reference<Duration.Duration>(
  "@media/server/TranscodeCapabilities/ProbeTimeout",
  { defaultValue: () => Duration.seconds(5) },
);

/** How long a negotiation waits, in all, for the probes its chain needs. */
export const NegotiationBudget = Context.Reference<Duration.Duration>(
  "@media/server/TranscodeCapabilities/NegotiationBudget",
  { defaultValue: () => Duration.seconds(3) },
);

const DIAGNOSIS_BUDGET = Duration.seconds(5);

/** Quarantines on one device this close together make the service open the device again. */
const DEVICE_CHECK_WINDOW_MS = 60_000;

/** How far a probe's missing prerequisites are followed. */
const MOST_PREREQUISITES = 4;

/** What a probe showed. */
interface Probed {
  readonly outcome: Inventory.ProbeOutcome;
  readonly detail: string;
  readonly millis: number;
}

type Priority = "warmup" | "demand";

/** The key a step exercises, the domain it runs in, and what it needs from the build. */
type Target = Pick<Step, "on" | "needs"> & { readonly key: CapabilityKey };

/** Signals of a crash: ffmpeg ran, and the stage it ran broke it. */
const CRASHES: ReadonlySet<string> = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE"]);

/** What a shell that could not run ffmpeg exits with: not executable, or not found. */
const NOT_RUN: ReadonlySet<number> = new Set([126, 127]);

const DEVICE_FAILED =
  /Device creation failed|for option 'init_hw_device'|Failed to (?:open|initialise) VAAPI/u;

/** What ffmpeg writes when a signal, not the stage, ended it. */
const ENDED_BY_SIGNAL = /received signal \d+|system signals, hard exiting/u;

/** The first line ffmpeg itself wrote, past libva's informational lines. */
const firstLine = (text: string): string =>
  (
    text
      .trim()
      .split("\n")
      .find((line) => !line.startsWith("libva info:")) ?? ""
  ).slice(0, 200);

/**
 * What one probe run proves, decided here alone. It passed when ffmpeg exited 0 and frames came
 * out. It was rejected when ffmpeg ran and refused by its own decision, exiting non-zero with an
 * error it wrote, or crashed (SIGSEGV, SIGBUS, SIGILL, SIGABRT, SIGFPE). Anything else proves
 * nothing: a clean exit without frames, a stop by any other signal or ffmpeg's exit on one, a
 * shell that could not run ffmpeg (126, 127), a spawn error, a timeout, or a device that would not
 * open.
 */
const probeOutcome = (
  result: Result.Result<string, MediaTools.MediaToolFailed>,
): Inventory.ProbeOutcome => {
  if (Result.isSuccess(result)) return probedFrames(result.success) > 0 ? "passed" : "inconclusive";
  const { signal, exitCode, stderrHead } = result.failure;

  if (signal !== null) return CRASHES.has(signal) ? "rejected" : "inconclusive";

  if (exitCode === null || NOT_RUN.has(exitCode)) return "inconclusive";

  return firstLine(stderrHead) === "" ||
    ENDED_BY_SIGNAL.test(stderrHead) ||
    DEVICE_FAILED.test(stderrHead)
    ? "inconclusive"
    : "rejected";
};

/** Every component a build listing shows: codecs ffmpeg decodes, decoders, encoders, filters, hardware accelerations. */
const featuresOf = (
  codecs: string,
  filters: string,
  hwaccels: string,
): ReadonlySet<BuildFeature> => {
  const features = new Set<BuildFeature>();

  for (const line of codecs.split("\n")) {
    const codec = /^ ([D.])([E.])[VAS.D.][I.][L.][S.]\s+(\S+)\s/u.exec(line);

    if (codec !== null) {
      const [, decodes, encodes, name = ""] = codec;
      const decoders = /\(decoders: ([^)]*)\)/u.exec(line)?.[1]?.trim().split(/\s+/u);
      const encoders = /\(encoders: ([^)]*)\)/u.exec(line)?.[1]?.trim().split(/\s+/u);

      if (decodes === "D") {
        features.add(`decodes:${name}`);

        for (const decoder of decoders ?? [name]) features.add(`decoder:${decoder}`);
      }

      if (encodes === "E") {
        for (const encoder of encoders ?? [name]) features.add(`encoder:${encoder}`);
      }
    }
  }

  for (const line of filters.split("\n")) {
    const name = /^ \S{2,3}\s+(\S+)\s+\S*->\S*/u.exec(line)?.[1];

    if (name !== undefined) features.add(`filter:${name}`);
  }

  for (const line of hwaccels.split("\n").slice(1)) {
    const name = line.trim();

    if (name !== "") features.add(`hwaccel:${name}`);
  }

  return features;
};

/**
 * The probe that would prove `target`: a generated clip's, unless `sourceOnly`, else the asking
 * source's first second for a decoder; undefined when neither exercises it.
 */
const plannedProbe = (
  target: Target,
  snapshot: CapabilitySnapshot,
  request: Request | undefined,
  sourceOnly: boolean,
):
  | {
      readonly plan: Result.Result<ProbePlan, Rejection>;
      readonly scope: Inventory.SourceScope | undefined;
    }
  | undefined => {
  const generated = sourceOnly ? undefined : probeFor(target.key, snapshot);

  if (generated !== undefined) return { plan: generated, scope: undefined };

  if (request === undefined) return undefined;
  const fromSource = sourceProbeFor(target.key, request.source, snapshot);

  return fromSource === undefined ? undefined : { plan: fromSource, scope: request.scope };
};

/** A clip being made, or made: its path, or none when this build cannot make it. */
type ClipMaking = Deferred.Deferred<Option.Option<string>>;

type ClipMakings = ReadonlyMap<ClipName, ClipMaking>;

/** When nobody waits on a probe; warmup takes a turn only then. */
interface Demand {
  readonly waiting: number;
  readonly idle: Deferred.Deferred<void>;
}

/** Runs some shared work under `name`, or waits for the run already under way. */
type Shared<K, A> = (
  name: K,
  work: Effect.Effect<Option.Option<A>>,
  keep: boolean,
) => Effect.Effect<Option.Option<A>>;

/**
 * Work every caller of one name shares: one run at a time, forked in `scope`, so a caller that
 * stops waiting, as at a negotiation's deadline, leaves it running for the others. A run's value
 * stays for later callers when `keep`; a run that answers none, fails, or is interrupted leaves
 * nothing behind, and the next caller starts it again.
 */
const sharing = <K, A>(scope: Scope.Scope): Effect.Effect<Shared<K, A>> =>
  Effect.map(
    Ref.make<ReadonlyMap<K, Deferred.Deferred<Option.Option<A>>>>(new Map()),
    (runs): Shared<K, A> =>
      (name, work, keep) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const fresh = yield* Deferred.make<Option.Option<A>>();

            const running = yield* Ref.modify(runs, (known) => {
              const existing = known.get(name);

              return existing === undefined
                ? ([undefined, new Map(known).set(name, fresh)] as const)
                : ([existing, known] as const);
            });

            if (running !== undefined) return yield* restore(Deferred.await(running));

            const settle = (result: Option.Option<A>) =>
              Ref.update(runs, (known) => {
                if ((keep && Option.isSome(result)) || known.get(name) !== fresh) return known;
                const next = new Map(known);
                next.delete(name);

                return next;
              }).pipe(Effect.andThen(Deferred.succeed(fresh, result)));

            yield* work.pipe(
              Effect.onExit((exit) => settle(Exit.isSuccess(exit) ? exit.value : Option.none())),
              Effect.forkIn(scope),
            );

            return yield* restore(Deferred.await(fresh));
          }),
        ),
  );

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probeTimeout = yield* ProbeTimeout;
  const budget = yield* NegotiationBudget;
  const scope = yield* Effect.scope;
  const inventory = yield* Ref.make(Inventory.empty);
  const queue = yield* Semaphore.make(1);
  const inFlight = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
  const clips = yield* Ref.make<ClipMakings>(new Map());
  const identified = yield* Deferred.make<void>();
  const builds = yield* sharing<"build", Inventory.BuildIdentity>(scope);
  const idle = yield* Deferred.make<void>();
  const demand = yield* Ref.make<Demand>({ waiting: 0, idle });
  const clipFolder = path.join(config.dataDir, "transcode-probes");

  yield* Deferred.succeed(idle, undefined);

  const mode = config.hardwareAcceleration;

  const domains: ReadonlyArray<DomainBinding> = GPU_PREFERENCE.filter(
    (domain) => mode === "auto" || domain === mode,
  ).map((domain) => ({ domain, device: DOMAINS[domain].device(config) }));

  const bound = (domain: Domain): DomainBinding | undefined =>
    domains.find((binding) => binding.domain === domain);

  /** Domains whose device ffmpeg opened. */
  const opened = Effect.gen(function* () {
    const devices = (yield* Ref.get(inventory)).devices;

    return domains.filter((binding) => devices.get(binding.domain)?.opened === true);
  });

  const now = Clock.currentTimeMillis;

  /** A snapshot of shared evidence that probes assemble their chains from. */
  const probeSnapshot = Effect.gen(function* () {
    return Inventory.snapshot(yield* Ref.get(inventory), undefined, yield* now, domains, new Set());
  });

  const update = (change: (known: Inventory.Inventory) => Inventory.Inventory) =>
    Ref.update(inventory, change);

  const readTrimmed = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );

  const identifyDevice = Effect.fnUntraced(function* (binding: DomainBinding) {
    const device = path.join("/sys/class/drm", path.basename(binding.device), "device");
    const vendor = yield* readTrimmed(path.join(device, "vendor"));
    const model = yield* readTrimmed(path.join(device, "device"));
    const revision = yield* readTrimmed(path.join(device, "revision"));

    const kernelDriver = yield* fs.readLink(path.join(device, "driver")).pipe(
      Effect.map((target) => path.basename(target)),
      Effect.option,
    );

    const log = yield* tools
      .ffmpegLog(
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "verbose",
          ...DOMAINS[binding.domain].deviceArgs(binding.device),
          "-f",
          "lavfi",
          "-i",
          "nullsrc=s=64x64:d=0.1",
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ],
        { timeout: probeTimeout },
      )
      .pipe(Effect.result);

    const identity: Inventory.DeviceIdentity = {
      domain: binding.domain,
      node: binding.device,
      opened: Result.isSuccess(log),
      pci:
        Option.isSome(vendor) && Option.isSome(model)
          ? `${vendor.value.replace(/^0x/u, "")}:${model.value.replace(/^0x/u, "")}${Option.match(revision, { onNone: () => "", onSome: (rev) => ` rev ${rev.replace(/^0x/u, "")}` })}`
          : undefined,
      kernelDriver: Option.getOrUndefined(kernelDriver),
      userDriver: Result.isSuccess(log)
        ? /driver: (.+?)\.?$/mu.exec(log.success)?.[1]?.trim()
        : undefined,
      at: yield* now,
    };

    yield* Effect.logInfo("TranscodeCapabilities.device").pipe(
      Effect.annotateLogs({
        domain: identity.domain,
        node: identity.node,
        opened: identity.opened,
        pci: identity.pci,
        kernelDriver: identity.kernelDriver,
        userDriver: identity.userDriver,
      }),
    );

    return identity;
  });

  /** Reads the build's listings; none when one failed, which records nothing. */
  const listBuild = Effect.gen(function* () {
    const listed = yield* Effect.all([
      tools.ffmpeg(["-hide_banner", "-version"]),
      tools.ffmpeg(["-hide_banner", "-codecs"]),
      tools.ffmpeg(["-hide_banner", "-filters"]),
      tools.ffmpeg(["-hide_banner", "-hwaccels"]),
    ]).pipe(Effect.result);

    if (Result.isFailure(listed)) {
      yield* Effect.logWarning("TranscodeCapabilities.listing_failed", listed.failure);

      return Option.none<Inventory.BuildIdentity>();
    }

    const [version, codecs, filters, hwaccels] = listed.success;

    const build: Inventory.BuildIdentity = {
      version: firstLine(version),
      kernel: Option.getOrElse(yield* readTrimmed("/proc/sys/kernel/osrelease"), () => ""),
      features: featuresOf(codecs, filters, hwaccels),
      at: yield* now,
    };

    yield* update((known) => Inventory.withBuild(known, build));

    if (domains.length > 0) {
      yield* Effect.logDebug("TranscodeCapabilities.build").pipe(
        Effect.annotateLogs({
          version: build.version,
          kernel: build.kernel,
          features: build.features.size,
        }),
      );
    }

    return Option.some(build);
  });

  /** Reads the build's listings unless a reading worked; one that failed is read again here. */
  const knowBuild = Effect.gen(function* () {
    if (Option.isSome((yield* Ref.get(inventory)).build)) return;
    yield* builds("build", listBuild, false);
  });

  const identifyDevices = Effect.forEach(
    domains,
    (binding) =>
      identifyDevice(binding).pipe(
        Effect.flatMap((identity) => update((known) => Inventory.withDevice(known, identity))),
      ),
    { discard: true },
  ).pipe(Effect.ensuring(Deferred.succeed(identified, undefined)));

  /**
   * Waits for the build's listings, read again if the last reading failed, and the start's device
   * identities, which take well under a second.
   */
  const ready = Effect.andThen(knowBuild, Deferred.await(identified));

  /** Settles `target` from the listing where it can: an absent component, or a CPU row present. */
  const settleFromListing = Effect.fnUntraced(function* (target: Target) {
    const known = yield* Ref.get(inventory);

    if (Option.isNone(known.build)) return false;
    const { features } = known.build.value;
    const needs = [...target.needs, ...(target.on === "cpu" ? [] : DOMAINS[target.on].needs)];
    const missing = needs.find((need) => !features.has(need));
    const capability = Inventory.capabilityOf(known, target.key);
    const at = yield* now;

    if (missing !== undefined) {
      if (capability.status !== "unsupported") {
        yield* update((current) =>
          Inventory.record(
            current,
            target.key,
            Inventory.Evidence.Build({ at, feature: missing, present: false }),
            capability.epoch,
          ),
        );
      }

      return true;
    }

    if (target.on !== "cpu") return false;

    if (capability.status === "unknown") {
      const [first = "filter:null"] = needs;

      yield* update((current) =>
        Inventory.record(
          current,
          target.key,
          Inventory.Evidence.Build({ at, feature: first, present: true }),
          capability.epoch,
        ),
      );
    }

    return true;
  });

  const clipOf = (clip: ClipName): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const fresh = yield* Deferred.make<Option.Option<string>>();

      const [existing, owner] = yield* Ref.modify(
        clips,
        (current): readonly [readonly [ClipMaking, boolean], ClipMakings] => {
          const known = current.get(clip);

          return known === undefined
            ? [[fresh, true], new Map(current).set(clip, fresh)]
            : [[known, false], current];
        },
      );

      if (!owner) return yield* Deferred.await(existing);
      const file = path.join(clipFolder, `${clip}.mkv`);
      const made = PROBE_CLIPS[clip];

      const written = yield* Effect.gen(function* () {
        const size = yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );

        if (size > 0) return Option.some(file);
        const build = (yield* Ref.get(inventory)).build;

        if (Option.isNone(build) || !build.value.features.has(made.needs))
          return Option.none<string>();
        const temporary = `${file}.part.mkv`;

        yield* fs.makeDirectory(clipFolder, { recursive: true });
        yield* tools.ffmpegInBackground(
          ["-hide_banner", "-nostdin", "-v", "error", "-y", ...made.args, temporary],
          { timeout: Duration.times(probeTimeout, 4) },
        );
        yield* fs.rename(temporary, file);

        return Option.some(file);
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("TranscodeCapabilities.clip_failed", error).pipe(
            Effect.annotateLogs({ clip }),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

      yield* Deferred.succeed(fresh, written);

      return written;
    });

  /** Holds warmup back while a negotiation or a diagnosis waits on a probe. */
  const asDemand = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const next = yield* Deferred.make<void>();

        yield* Ref.update(demand, (current) =>
          current.waiting === 0
            ? { waiting: 1, idle: next }
            : { ...current, waiting: current.waiting + 1 },
        );
      }),
      () => effect,
      () =>
        Ref.modify(
          demand,
          (current) => [current, { ...current, waiting: current.waiting - 1 }] as const,
        ).pipe(
          Effect.flatMap((before) =>
            before.waiting === 1 ? Deferred.succeed(before.idle, undefined) : Effect.void,
          ),
          Effect.asVoid,
        ),
    );

  const waitForIdle = Ref.get(demand).pipe(
    Effect.flatMap((current) => Deferred.await(current.idle)),
  );

  /** Runs `plan` once per required run, one probe at a time, and says what it showed. */
  const runProbe = Effect.fnUntraced(function* (
    plan: ProbePlan,
    request: Request | undefined,
    priority: Priority,
  ) {
    const input = yield* ProbeInput.$match(plan.input, {
      Clip: ({ clip }) =>
        clipOf(clip).pipe(Effect.map(Option.map((file) => ({ file, stream: 0 })))),
      Source: () =>
        Effect.succeed(
          request === undefined
            ? Option.none<{ readonly file: string; readonly stream: number }>()
            : Option.some({ file: request.path, stream: request.stream }),
        ),
    });

    if (Option.isNone(input)) return Option.none<Probed>();
    const args = probeCommandArgs(plan.pipeline, plan.input, input.value.file, input.value.stream);
    const run = priority === "warmup" ? tools.ffmpegInBackground : tools.ffmpeg;
    const started = yield* now;
    let probed: Probed | undefined;

    for (let attempt = 0; attempt < plan.runs && probed?.outcome !== "rejected"; attempt += 1) {
      const result = yield* queue.withPermits(1)(
        run(args, { timeout: probeTimeout }).pipe(Effect.result),
      );

      const outcome = probeOutcome(result);

      probed = {
        outcome,
        detail: Result.isSuccess(result)
          ? outcome === "passed"
            ? ""
            : "no frames came out"
          : firstLine(
              result.failure.stderrHead === "" ? result.failure.stderr : result.failure.stderrHead,
            ),
        millis: (yield* now) - started,
      };

      if (outcome !== "passed") break;
    }

    return Option.fromNullishOr(probed);
  });

  /**
   * The probe to run for `target`: a generated clip's when this build can make the clip, else the
   * asking source's, so a decoder whose clip this build cannot encode is still proven on real
   * files.
   */
  const chosenProbe = Effect.fnUntraced(function* (
    target: Target,
    snapshot: CapabilitySnapshot,
    request: Request | undefined,
  ) {
    const planned = plannedProbe(target, snapshot, request, false);

    if (planned === undefined || planned.scope !== undefined || Result.isFailure(planned.plan)) {
      return planned;
    }

    const clip = ProbeInput.$match(planned.plan.success.input, {
      Clip: (input): ClipName | undefined => input.clip,
      Source: () => undefined,
    });

    if (clip === undefined || Option.isSome(yield* clipOf(clip))) return planned;

    return plannedProbe(target, snapshot, request, true);
  });

  /**
   * Makes `target` known if it can: the listing settles what it can, a probe the rest, after the
   * prerequisites its probe needs. Only one probe of a key runs at a time; a second caller waits
   * for the first's result. Evidence counts only under the epoch the probe started in.
   */
  const ensure = (
    target: Target,
    priority: Priority,
    request: Request | undefined,
    depth = 0,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* ready;

      if (yield* settleFromListing(target)) return;
      const binding = target.on === "cpu" ? undefined : bound(target.on);

      if (binding === undefined) return;

      if (!(yield* opened).some((open) => open.domain === binding.domain)) return;
      let planned = yield* chosenProbe(target, yield* probeSnapshot, request);

      if (planned === undefined) return;

      if (
        Result.isFailure(planned.plan) &&
        Rejection.$is("NotVerified")(planned.plan.failure) &&
        depth < MOST_PREREQUISITES
      ) {
        const { key, on, needs } = planned.plan.failure;

        yield* ensure({ key, on, needs }, priority, request, depth + 1);
        planned = yield* chosenProbe(target, yield* probeSnapshot, request);
      }

      if (planned === undefined || Result.isFailure(planned.plan)) return;
      const plan = planned.plan.success;
      const sourceScope = planned.scope;
      const at = yield* now;

      if (!Inventory.probeable(yield* Ref.get(inventory), target.key, at, sourceScope)) return;
      const id = `${target.key}@${sourceScope ?? ""}`;
      const mine = yield* Deferred.make<void>();

      const theirs = yield* Ref.modify(inFlight, (current) => {
        const running = current.get(id);

        return running === undefined
          ? ([undefined, new Map(current).set(id, mine)] as const)
          : ([running, current] as const);
      });

      if (theirs !== undefined) {
        yield* Deferred.await(theirs);

        return;
      }

      const epoch = Inventory.capabilityOf(yield* Ref.get(inventory), target.key).epoch;

      const probe = runProbe(plan, request, priority).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (probed) =>
              update((current) =>
                Inventory.record(
                  current,
                  target.key,
                  Inventory.Evidence.Probe({
                    at,
                    outcome: probed.outcome,
                    source: sourceScope,
                    detail: probed.detail,
                    millis: probed.millis,
                  }),
                  epoch,
                ),
              ).pipe(
                Effect.andThen(
                  Effect.logDebug("TranscodeCapabilities.probed").pipe(
                    Effect.annotateLogs({
                      key: target.key,
                      outcome: probed.outcome,
                      source: sourceScope !== undefined,
                      millis: probed.millis,
                      detail: probed.detail,
                    }),
                  ),
                ),
              ),
          }),
        ),
        Effect.ensuring(
          Ref.update(inFlight, (current) => {
            const next = new Map(current);
            next.delete(id);

            return next;
          }).pipe(Effect.andThen(Deferred.succeed(mine, undefined))),
        ),
      );

      // The probe runs to its end in the service's scope, so a caller that stops waiting for it,
      // as at a negotiation's deadline, still leaves its evidence behind.
      yield* probe.pipe(Effect.forkIn(scope));
      yield* Deferred.await(mine);
    });

  const targetsOf = (request: Request): ReadonlyMap<CapabilityKey, Step> =>
    candidateKeys(request.source, request.intent, {
      domains,
      verified: new Set(),
      excluded: new Set(),
    });

  const snapshotFor = Effect.fnUntraced(function* (request: Request) {
    return Inventory.snapshot(
      yield* Ref.get(inventory),
      request.scope,
      yield* now,
      yield* opened,
      request.excluded,
    );
  });

  const settleAll = Effect.fnUntraced(function* (targets: ReadonlyMap<CapabilityKey, Step>) {
    for (const [key, step] of targets) {
      yield* settleFromListing({ key, on: step.on, needs: step.needs });
    }
  });

  const knownNow = Effect.fn("TranscodeCapabilities.current")(function* (request: Request) {
    yield* ready;
    yield* settleAll(targetsOf(request));

    return yield* snapshotFor(request);
  });

  const resolve = Effect.fn("TranscodeCapabilities.resolve")(function* (request: Request) {
    yield* ready;
    const targets = targetsOf(request);

    yield* settleAll(targets);
    const deadline = (yield* now) + Duration.toMillis(budget);

    for (let round = 0; round <= targets.size; round += 1) {
      const known = yield* Ref.get(inventory);
      const at = yield* now;
      const snapshot = yield* snapshotFor(request);

      const unknown = [...targets.keys()].filter(
        (key) => !snapshot.verified.has(key) && Inventory.probeable(known, key, at, request.scope),
      );

      if (unknown.length === 0) return snapshot;

      const hopeful = planVideo(request.source, request.intent, {
        ...snapshot,
        verified: new Set([...snapshot.verified, ...unknown]),
      });

      if (Result.isFailure(hopeful)) return snapshot;

      const needed = hopeful.success.pipeline.steps.filter(
        (step) => !snapshot.verified.has(step.capability),
      );

      if (needed.length === 0) return snapshot;
      const left = deadline - at;

      if (left <= 0) return snapshot;

      const settled = yield* asDemand(
        Effect.forEach(
          needed,
          (step) =>
            ensure({ key: step.capability, on: step.on, needs: step.needs }, "demand", request),
          { discard: true },
        ),
      ).pipe(Effect.timeoutOption(Duration.millis(left)));

      if (Option.isNone(settled)) return yield* snapshotFor(request);
    }

    return yield* snapshotFor(request);
  });

  const reopenIfStruck = Effect.fnUntraced(function* (domain: Domain, at: number) {
    const binding = bound(domain);

    if (binding === undefined) return;
    const known = yield* Ref.get(inventory);

    const struck = Inventory.quarantinedSince(known, at - DEVICE_CHECK_WINDOW_MS).filter(
      (key) => VIDEO_OPS.find((entry) => entry.id === implOf(key))?.on === domain,
    );

    if (struck.length < 2) return;
    const before = known.devices.get(binding.domain);
    const identity = yield* identifyDevice(binding);

    const changed =
      !identity.opened ||
      before?.userDriver !== identity.userDriver ||
      before?.pci !== identity.pci ||
      before?.kernelDriver !== identity.kernelDriver;

    yield* update((inventoryNow) => {
      const recorded = Inventory.withDevice(inventoryNow, identity);

      return changed ? Inventory.forget(recorded, domain) : recorded;
    });
    yield* Effect.logWarning("TranscodeCapabilities.device_reopened").pipe(
      Effect.annotateLogs({ domain, opened: identity.opened, changed }),
    );
  });

  const diagnose = Effect.fn("TranscodeCapabilities.diagnose")(function* (failed: FailedRun) {
    const attribution = attribute(failed.pipeline, failed.owners, failed.failure);

    if (Attribution.$is("NotVideo")(attribution))
      return Diagnosis.NotVideo({ reason: attribution.reason });

    const suspects = attribution.suspects.flatMap((index) => {
      const step = failed.pipeline.steps[index];

      return step === undefined ? [] : [step];
    });

    if (suspects.length === 0) return Diagnosis.Unexplained();
    // Each verdict counts under the epoch its key had when the diagnosis began, so diagnoses of
    // one outage that overlap strike once.
    const began = yield* Ref.get(inventory);

    const epochOf = (step: Step): number => Inventory.capabilityOf(began, step.capability).epoch;

    yield* ready;
    const deadline = (yield* now) + Duration.toMillis(DIAGNOSIS_BUDGET);
    const passed: Array<Step> = [];
    const undecided: Array<Step> = [];

    for (const step of suspects) {
      const at = yield* now;
      const snapshot = yield* probeSnapshot;

      const planned = yield* chosenProbe(
        { key: step.capability, on: step.on, needs: step.needs },
        snapshot,
        failed.request,
      );

      if (deadline <= at || planned === undefined || Result.isFailure(planned.plan)) {
        undecided.push(step);
      } else {
        const probed = yield* asDemand(
          runProbe(planned.plan.success, failed.request, "demand"),
        ).pipe(Effect.timeoutOption(Duration.millis(deadline - at)), Effect.map(Option.flatten));

        const outcome = Option.match(probed, {
          onNone: () => "inconclusive" as const,
          onSome: (shown) => shown.outcome,
        });

        if (outcome === "rejected") {
          const reproducedAt = yield* now;
          const source = planned.scope;

          yield* update((current) =>
            Inventory.reproduced(current, step.capability, source, reproducedAt, epochOf(step)),
          );
          yield* Effect.logWarning(
            source === undefined
              ? "TranscodeCapabilities.quarantined"
              : "TranscodeCapabilities.source_reproduced",
          ).pipe(
            Effect.annotateLogs({
              key: step.capability,
              detail: Option.match(probed, { onNone: () => "", onSome: (shown) => shown.detail }),
            }),
          );

          // Only a generated clip's failure speaks for other files; the source's is its own.
          if (source !== undefined) return Diagnosis.Source({ impls: [step.impl] });
          yield* reopenIfStruck(step.on, reproducedAt);

          return Diagnosis.Capability({ keys: [step.capability], impls: [step.impl] });
        }

        if (outcome === "passed") passed.push(step);
        else undecided.push(step);
      }
    }

    const at = yield* now;

    for (const step of passed) {
      yield* update((current) =>
        Inventory.notReproduced(current, step.capability, failed.request.scope, at, epochOf(step)),
      );
    }

    yield* Effect.logWarning("TranscodeCapabilities.diagnosed").pipe(
      Effect.annotateLogs({
        named: attribution.named,
        sourceExcluded: passed.map((step) => step.impl).join(","),
        undecided: undecided.map((step) => step.impl).join(","),
      }),
    );

    return undecided.length > 0
      ? Diagnosis.Undecided({ impls: undecided.map((step) => step.impl) })
      : Diagnosis.Source({ impls: passed.map((step) => step.impl) });
  });

  const hardwareEncoder = Effect.gen(function* () {
    const known = yield* Ref.get(inventory);
    const at = yield* now;

    return domains.find((binding) =>
      [...known.capabilities.values()].some(
        (capability) =>
          capability.status === "verified" &&
          !Inventory.isQuarantined(capability, at) &&
          VIDEO_OPS.some(
            (entry) =>
              entry.id === implOf(capability.key) &&
              entry.op === "Encode" &&
              entry.on === binding.domain,
          ),
      ),
    )?.domain;
  });

  const warmup = Effect.gen(function* () {
    yield* Effect.all([knowBuild, identifyDevices], { concurrency: "unbounded", discard: true });

    for (const binding of yield* opened) {
      for (const step of probedSteps(binding.domain, {
        domains,
        verified: new Set(),
        excluded: new Set(),
      })) {
        yield* waitForIdle;
        yield* ensure(
          { key: step.capability, on: step.on, needs: step.needs },
          "warmup",
          undefined,
        );
      }
    }

    if (domains.length === 0) return;

    yield* Effect.logDebug("TranscodeCapabilities.warm").pipe(
      Effect.annotateLogs({
        verified: [...(yield* Ref.get(inventory)).capabilities.values()].filter(
          (capability) => capability.status === "verified",
        ).length,
      }),
    );
  });

  yield* warmup.pipe(Effect.forkScoped);

  return Service.of({
    current: knownNow,
    resolve,
    diagnose,
    inventory: Ref.get(inventory),
    hardwareEncoder,
  });
});

/** The capability service, from `HARDWARE_ACCELERATION`, `QSV_DEVICE`, and `VAAPI_DEVICE`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | MediaTools.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(Service, make);
