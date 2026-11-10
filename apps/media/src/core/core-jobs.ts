import { hostname } from "node:os";

import type {
  ContentDomain,
  CoreJobKind,
  CoreJobPayload,
  Lease,
} from "@media/contracts/server-functions";
import { serverFunctions } from "@media/contracts/server-functions";
import {
  Cause,
  Crypto,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

import * as CoreSession from "./core-session.ts";

/** A handler's expected failure, recorded on the job. */
export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
  /** Shown to admins on the job; no paths outside the library or secrets. */
  message: Schema.String,
  /** Return the job to the queue while it has attempts left, instead of failing it for good. */
  retry: Schema.Boolean,
}) {}

/** The core answered that this attempt no longer holds its job: canceled, or another holds it. */
export class JobStopped extends Schema.TaggedError<JobStopped>()("JobStopped", {
  outcome: Schema.Literals(["canceled", "lost"]),
}) {}

/** A job this server holds, with its payload narrowed to the handler's kind. */
interface HeldJob<Kind extends CoreJobKind> {
  readonly lease: Lease;
  readonly payload: Extract<CoreJobPayload, { readonly kind: Kind }>;
}

/** Progress the next lease renewal reports. */
interface Progress {
  readonly done: number;
  readonly total: number | null;
  readonly message?: string | undefined;
}

/** Runs the jobs of one kind on the core's worker protocol. */
export interface Handler<Kind extends CoreJobKind = CoreJobKind> {
  readonly kind: Kind;
  /**
   * Runs a claimed job and returns the message recorded when it succeeds. `report` replaces what
   * the next lease renewal reports. A lease-checked call that answers canceled or lost fails the
   * run with `JobStopped`, which settles nothing: the core already moved the job.
   */
  readonly run: (
    job: HeldJob<Kind>,
    report: (progress: Progress) => Effect.Effect<void>,
  ) => Effect.Effect<string, JobFailed | JobStopped>;
}

/** Erases a handler's kind for the worker, which dispatches by the claimed payload's kind. */
export const handler = <Kind extends CoreJobKind>(defined: Handler<Kind>): AnyHandler => ({
  kind: defined.kind,
  run: (job, report) =>
    job.payload.kind === defined.kind
      ? defined.run({ lease: job.lease, payload: narrow(defined.kind, job.payload) }, report)
      : Effect.fail(new JobFailed({ message: `This is not a ${defined.kind} job`, retry: false })),
});

// SAFETY: a type predicate, not checked by the compiler. `CoreJobPayload` is a union tagged by
// `kind`, so a payload whose kind equals `kind` is exactly that member.
const isKind =
  <Kind extends CoreJobKind>(kind: Kind) =>
  (payload: CoreJobPayload): payload is Extract<CoreJobPayload, { readonly kind: Kind }> =>
    payload.kind === kind;

const narrow = <Kind extends CoreJobKind>(
  kind: Kind,
  payload: CoreJobPayload,
): Extract<CoreJobPayload, { readonly kind: Kind }> => {
  if (isKind(kind)(payload)) return payload;

  throw new Error(`A ${payload.kind} payload reached the ${kind} handler`);
};

/** A handler of any kind, as the worker holds it. */
export interface AnyHandler {
  readonly kind: CoreJobKind;
  readonly run: (
    job: HeldJob<CoreJobKind>,
    report: (progress: Progress) => Effect.Effect<void>,
  ) => Effect.Effect<string, JobFailed | JobStopped>;
}

/** The server's worker pools (ADR 0014) and the domain whose libraries gate each, if any. */
const POOLS = {
  movies: {
    domain: "movies",
    kinds: ["movies.scan", "movies.metadata", "movies.person"],
  },
  /**
   * Imports claim whether or not movies has a library yet: an import adds the libraries it needs,
   * so on an empty install it is what makes the first one.
   */
  "movies.import": { domain: null, kinds: ["movies.import.jellyfin", "movies.import.plex"] },
  "movies.background": { domain: "movies", kinds: ["movies.trickplay"] },
  server: { domain: null, kinds: ["server.backup"] },
} as const satisfies Record<
  string,
  { readonly domain: ContentDomain | null; readonly kinds: ReadonlyArray<CoreJobKind> }
>;

/** A pool's name. */
type Pool = keyof typeof POOLS;

const POOL_NAMES: ReadonlyArray<Pool> = ["movies", "movies.background", "movies.import", "server"];

/** The most jobs each pool runs at once on this server; each a whole number of at least 1. */
export type PoolCaps = { readonly [Name in Pool]: number };

type JobEnd = Data.TaggedEnum<{
  Finished: { readonly message: string };
  Failed: { readonly error: JobFailed };
  Stopped: { readonly outcome: "canceled" | "lost" };
}>;

const JobEnd = Data.taggedEnum<JobEnd>();

const LEASE_MS = 60_000;

const RENEW_EVERY = Duration.seconds(15);

const RESCAN_EVERY = Duration.seconds(30);

const SETTLE_RETRY = Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 5 }));

/** Wraps a lease answer: its value while held, `JobStopped` otherwise. */
export const held = <Value>(
  answer:
    | { readonly outcome: "held"; readonly value: Value }
    | { readonly outcome: "canceled" }
    | { readonly outcome: "lost" },
): Effect.Effect<Value, JobStopped> =>
  answer.outcome === "held"
    ? Effect.succeed(answer.value)
    : Effect.fail(new JobStopped({ outcome: answer.outcome }));

const make = Effect.fn("CoreJobs.make")(function* ({
  handlers,
  caps,
}: {
  readonly handlers: ReadonlyArray<AnyHandler>;
  readonly caps: PoolCaps;
}) {
  const session = yield* CoreSession.Service;
  const crypto = yield* Crypto.Crypto;
  const suffix = Buffer.from(yield* crypto.randomBytes(6).pipe(Effect.orDie)).toString("hex");
  const workerId = `${hostname()}:${String(process.pid)}:${suffix}`;
  const byKind = new Map(handlers.map((one) => [one.kind, one]));
  const domains = yield* Ref.make<ReadonlySet<ContentDomain>>(new Set());
  // Jobs run in the layer's scope, not in the scope of the stream step that claimed them.
  const scope = yield* Scope.Scope;

  const keepLease = (lease: Lease, progress: Ref.Ref<Progress>): Effect.Effect<JobEnd> =>
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(RENEW_EVERY);

        const current = yield* Ref.get(progress);
        const progressed = { done: current.done, total: current.total };

        const renewal =
          current.message === undefined
            ? { lease, leaseMs: LEASE_MS, progress: progressed }
            : { lease, leaseMs: LEASE_MS, progress: progressed, message: current.message };

        const answer = yield* session.call(serverFunctions.jobsReport, renewal).pipe(
          Effect.asSome,
          Effect.catch((error) =>
            Effect.logWarning("CoreJobs.renew_failed", error).pipe(Effect.as(Option.none())),
          ),
        );

        if (Option.isSome(answer)) {
          const { outcome } = answer.value;

          if (outcome === "canceled" || outcome === "lost") return JobEnd.Stopped({ outcome });
        }
      }
    });

  const settle = Effect.fn("CoreJobs.settle")(function* (lease: Lease, end: JobEnd) {
    if (JobEnd.$is("Stopped")(end)) return;

    yield* session
      .call(serverFunctions.jobsFinish, {
        lease,
        end: JobEnd.$match(end, {
          Finished: ({ message }) => ({ outcome: "succeeded" as const, message }),
          Failed: ({ error }) => ({
            outcome: "failed" as const,
            error: error.message,
            retry: error.retry,
          }),
          Stopped: () => ({ outcome: "succeeded" as const }),
        }),
      })
      .pipe(
        Effect.retry({
          while: (error) => Predicate.isTagged(error, "TransportError"),
          schedule: SETTLE_RETRY,
        }),
        Effect.catch((error) => Effect.logWarning("CoreJobs.settle_failed", error)),
      );
  });

  const runJob = Effect.fn("CoreJobs.runJob")(
    function* (job: HeldJob<CoreJobKind>, run: AnyHandler) {
      yield* Effect.logInfo("CoreJobs.claimed");
      const progress = yield* Ref.make<Progress>({ done: 0, total: null });

      const work = run
        .run(job, (next) => Ref.set(progress, next))
        .pipe(
          Effect.map((message) => JobEnd.Finished({ message })),
          Effect.catchTags({
            JobFailed: (error) => Effect.succeed(JobEnd.Failed({ error })),
            JobStopped: ({ outcome }) => Effect.succeed(JobEnd.Stopped({ outcome })),
          }),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("CoreJobs.handler_defect", cause).pipe(
                Effect.as(
                  JobEnd.Failed({
                    error: new JobFailed({
                      message: "The job stopped on an internal error",
                      retry: false,
                    }),
                  }),
                ),
              ),
          ),
        );

      const end = yield* Effect.raceFirst(work, keepLease(job.lease, progress));

      yield* settle(job.lease, end);

      yield* Effect.logInfo("CoreJobs.job_ended").pipe(
        Effect.annotateLogs({
          outcome: JobEnd.$match(end, {
            Finished: () => "succeeded",
            Failed: ({ error }) => (error.retry ? "retrying" : "failed"),
            Stopped: ({ outcome }) => outcome,
          }),
        }),
      );
    },
    (effect, job) =>
      effect.pipe(
        Effect.annotateLogs({ jobId: job.lease.jobId, kind: job.payload.kind, workerId }),
      ),
  );

  const pokes: Array<Effect.Effect<void>> = [];

  const runPool = Effect.fn("CoreJobs.runPool")(function* (pool: Pool) {
    const { domain } = POOLS[pool];
    const kinds = POOLS[pool].kinds.filter((kind) => byKind.has(kind));

    if (kinds.length === 0) return;

    const running = yield* Ref.make(0);
    const wake = yield* Queue.sliding<void>(1);
    const ready = yield* Ref.make(false);
    const poke = Queue.offer(wake, undefined).pipe(Effect.asVoid);

    const open =
      domain === null
        ? Effect.succeed(true)
        : Effect.map(Ref.get(domains), (withLibraries) => withLibraries.has(domain));

    const claimOne = Effect.gen(function* () {
      const answer = yield* session
        .call(serverFunctions.jobsClaim, { kinds, workerId, leaseMs: LEASE_MS })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("CoreJobs.claim_failed", error).pipe(
              Effect.as({ outcome: "idle" as const }),
            ),
          ),
        );

      if (answer.outcome === "idle") return false;

      const run = byKind.get(answer.payload.kind);

      // A pool claims only kinds it has handlers for, so this is a core answering out of contract:
      // hand the job back for another server rather than hold it until its lease lapses.
      if (run === undefined) {
        yield* session
          .call(serverFunctions.jobsFinish, {
            lease: answer.lease,
            end: { outcome: "failed", error: `No handler for ${answer.payload.kind}`, retry: true },
          })
          .pipe(Effect.ignore);

        return false;
      }

      yield* Ref.update(running, (count) => count + 1);

      yield* runJob({ lease: answer.lease, payload: answer.payload }, run).pipe(
        Effect.ensuring(Ref.update(running, (count) => count - 1).pipe(Effect.andThen(poke))),
        Effect.forkIn(scope),
      );

      return true;
    });

    const dispatch = Effect.gen(function* () {
      for (;;) {
        const claimable =
          (yield* open) && (yield* Ref.get(ready)) && (yield* Ref.get(running)) < caps[pool];

        if (!claimable || !(yield* claimOne)) return;
      }
    });

    yield* session.watch(serverFunctions.jobsWaiting, { kinds }).pipe(
      Stream.runForEach((rows) =>
        Ref.set(
          ready,
          rows.some((row) => row.ready && row.free > 0),
        ).pipe(Effect.andThen(poke)),
      ),
      Effect.forkScoped,
    );

    yield* poke.pipe(Effect.repeat(Schedule.spaced(RESCAN_EVERY)), Effect.forkScoped);

    yield* Stream.fromQueue(wake).pipe(
      Stream.runForEach(() => dispatch),
      Effect.forkScoped,
    );

    pokes.push(poke);
  });

  yield* Effect.forEach(POOL_NAMES, runPool, { discard: true });

  yield* session.watch(serverFunctions.scanDomains, {}).pipe(
    Stream.runForEach((rows) =>
      Ref.set(domains, new Set(rows.flatMap((row) => (row.hasLibraries ? [row.kind] : [])))).pipe(
        Effect.andThen(Effect.forEach(pokes, (poke) => poke, { discard: true })),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.logInfo("CoreJobs.ready").pipe(Effect.annotateLogs({ workerId }));
});

/**
 * Runs the core's jobs with `handlers` for the lifetime of the layer: one pool per ADR 0014, each
 * capped by `caps`, and a domain's pools only while `core/scans:domains` answers that the domain
 * has a library (ADR 0024).
 */
export const layer = <R>(
  setup: Effect.Effect<
    { readonly handlers: ReadonlyArray<AnyHandler>; readonly caps: PoolCaps },
    never,
    R
  >,
): Layer.Layer<never, never, R | CoreSession.Service | Crypto.Crypto> =>
  Layer.effectDiscard(Effect.flatMap(setup, make));
