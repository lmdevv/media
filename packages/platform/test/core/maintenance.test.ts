import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { JOB_TEXT_MAX, RESTORED_ERROR } from "../../convex/core/jobs/machine";
import { runFunction } from "../admin";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal, signIn, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { KINDS, kindDef } from "../../convex/core/jobs/kinds";
import {
  Lease,
  enqueue,
  eventually,
  freshKind,
  inSequence,
  retrying,
  waiting,
  worker,
} from "./jobs/driver";
import type { ProbeRunKind } from "./jobs/driver";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one through `v.id("jobs")`, which checks it again whenever a test sends it.
const isJobId = (value: unknown): value is Id<"jobs"> => Schema.is(Schema.String)(value);

// SAFETY: as `isJobId`, for the `users` id the stack answered through `v.id("users")`.
const isUserId = (value: unknown): value is Id<"users"> => Schema.is(Schema.String)(value);

// SAFETY: as `isJobId`, for the `authSessions` id the stack answered through `v.id("authSessions")`.
const isSessionId = (value: unknown): value is Id<"authSessions"> =>
  Schema.is(Schema.String)(value);

const BackupLease = Schema.Struct({ jobId: Schema.declare(isJobId), attempt: Schema.Finite });

const BackupClaim = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("claimed"), lease: BackupLease }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const Job = Schema.NullOr(
  Schema.Struct({
    status: Schema.String,
    attempts: Schema.Finite,
    strikes: Schema.Finite,
    message: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
);

const Settled = Schema.Struct({ settled: Schema.Finite });

const Ended = Schema.Struct({ ended: Schema.Finite });

const Left = Schema.Struct({ sessions: Schema.Finite, tokens: Schema.Finite });

const jobOf = (core: CoreStack, jobId: Id<"jobs">) =>
  runFunction(core, internal.core.jobs.admin.get, { jobId }, Job);

const finishBackup = (core: CoreStack, lease: typeof BackupLease.Type) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.finish,
      { lease, end: { outcome: "succeeded" } },
      Schema.Struct({ outcome: Schema.String }),
    ),
  );

/** Claims backup job `jobId`, ending at once any other backup an earlier run left to claim first. */
const claimBackup = async (
  core: CoreStack,
  jobId: Id<"jobs">,
  deadline = Date.now() + 120_000,
): Promise<typeof BackupLease.Type> => {
  const claim = await retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.claim,
      { kinds: ["server.backup"], workerId: `restore-${unique()}`, leaseMs: 60_000 },
      BackupClaim,
    ),
  );

  if (claim.outcome === "claimed" && claim.lease.jobId === jobId) return claim.lease;

  if (Date.now() > deadline) throw new Error(`Timed out waiting for a claim of ${jobId}`);

  if (claim.outcome === "claimed") await finishBackup(core, claim.lease);
  else await sleep(250);

  return claimBackup(core, jobId, deadline);
};

const settle = (core: CoreStack, before?: number) =>
  runFunction(
    core,
    internal.core.maintenance.settleRestoredJobs,
    before === undefined ? {} : { before },
    Settled,
  );

const PROBE_KINDS: ReadonlyArray<ProbeRunKind> = ["probe.wide", "probe.capped", "probe.items"];

/** One claim per slot of every probe kind: 8. */
const PROBE_SLOTS = PROBE_KINDS.flatMap((kind) =>
  Array.from({ length: kindDef(kind).cap }, () => kind),
);

/** Every running job a restored snapshot can hold: each kind's cap, added up. */
const RUNNING_MAX = KINDS.reduce((sum, def) => sum + def.cap, 0);

/** The longest lease a claim or report may ask for, so no lease lapses before the settle. */
const LONG_LEASE_MS = 10 * 60 * 1000;

/** Settles until a call finds no running job, so a test starts with none. */
const settleAll = (core: CoreStack) =>
  eventually("no running job to be left", async () =>
    (await settle(core)).settled === 0 ? true : null,
  );

const freeSlots = async (core: CoreStack): Promise<ReadonlyArray<number>> => {
  const states = await waiting(core, PROBE_KINDS);

  return PROBE_KINDS.map((kind) => states.find((state) => state.kind === kind)?.free ?? -1);
};

const serviceKey = async (core: CoreStack): Promise<string> => {
  const serviceId = await runFunction(
    core,
    internal.core.accounts.host.createService,
    { name: `restored server ${unique()}` },
    Schema.declare(isUserId),
  );

  const issued = await runFunction(
    core,
    internal.core.auth.apiKeys.issueServiceKey,
    { serviceId },
    Schema.Struct({ key: Schema.String }),
  );

  return issued.key;
};

const domainsAs = (core: CoreStack, signedIn: Awaited<ReturnType<typeof signIn>>) =>
  runServerAs(core, signedIn, api.core.scans.domains, {}, Schema.Unknown);

describe.skipIf(stack === undefined)("restore maintenance", { timeout: 300_000 }, () => {
  it("succeed the running backup and queue every other running job again with no strike", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "restore-admin", "admin");

    const { jobId: backupId } = await admin.signedIn.client.mutation(
      api.core.server.backups.run,
      {},
    );

    const backupLease = await claimBackup(stack, backupId);

    await inSequence(PROBE_KINDS, async (kind) => freshKind(stack, kind));

    // Every probe slot taken, and one job left queued.
    const queued = await inSequence(PROBE_KINDS, async (kind) =>
      enqueue(stack, kind, kindDef(kind).cap + 1),
    );

    const probe = worker(stack, `restore-${unique()}`);
    const claims = await inSequence(PROBE_SLOTS, async () => probe.claim(PROBE_KINDS));
    const leases = claims.flatMap((claim) => (claim.outcome === "claimed" ? [claim.lease] : []));
    const running = new Set(leases.map((lease) => lease.jobId));
    const waitingIds = queued.flat().filter((jobId) => !running.has(jobId));

    expect(leases).toHaveLength(PROBE_SLOTS.length);
    expect(leases.every((lease) => lease.attempt === 1)).toBe(true);
    expect(await freeSlots(stack)).toEqual([0, 0, 0]);

    expect((await settle(stack)).settled).toBeGreaterThanOrEqual(1);

    await eventually("every running job to be settled", async () => {
      const jobs = await inSequence(leases, async (lease) => jobOf(stack, lease.jobId));

      return jobs.every((job) => job?.status === "queued") ? jobs : null;
    });

    expect(await jobOf(stack, backupId)).toMatchObject({
      status: "succeeded",
      message: "Restored from this backup",
    });
    await inSequence(leases, async (lease) => {
      expect(await jobOf(stack, lease.jobId)).toEqual({
        status: "queued",
        attempts: 1,
        strikes: 0,
        message: null,
        error: RESTORED_ERROR,
      });
    });
    await inSequence(waitingIds, async (jobId) => {
      expect(await jobOf(stack, jobId)).toMatchObject({ status: "queued", attempts: 0 });
    });
    expect(await freeSlots(stack)).toEqual(PROBE_KINDS.map((kind) => kindDef(kind).cap));

    const [first] = leases;

    if (first === undefined) throw new Error("No probe job was claimed");

    expect(await probe.report(first)).toEqual({ outcome: "lost" });
    expect(await finishBackup(stack, backupLease)).toMatchObject({ outcome: "settled" });

    const again = await probe.claim(PROBE_KINDS);

    expect(again).toMatchObject({ outcome: "claimed", lease: { jobId: first.jobId, attempt: 2 } });

    if (again.outcome === "claimed") await probe.finish(again.lease, { outcome: "succeeded" });

    await inSequence(PROBE_KINDS, async (kind) => freshKind(stack, kind));
  });

  it("settle in one call every running job the caps allow, each with the longest message", async () => {
    if (stack === undefined) return;
    await freshKind(stack, "probe.wide");
    await settleAll(stack);

    const workerId = `restore-full-${unique()}`;
    const jobIds = await enqueue(stack, "probe.wide", RUNNING_MAX);

    const leases = await runFunction(
      stack,
      internal.core.jobs.probe.claimPastCap,
      { jobIds: [...jobIds], workerId, leaseMs: LONG_LEASE_MS },
      Schema.Array(Lease),
    );

    const probe = worker(stack, workerId);
    const message = "m".repeat(JOB_TEXT_MAX);

    await inSequence(leases, async (lease) =>
      probe.report(lease, { message, leaseMs: LONG_LEASE_MS }),
    );

    expect(await settle(stack)).toEqual({ settled: RUNNING_MAX });

    // Read at once: a job a later call would settle is still running here.
    await inSequence(jobIds, async (jobId) => {
      expect(await jobOf(stack, jobId)).toEqual({
        status: "queued",
        attempts: 1,
        strikes: 0,
        message,
        error: RESTORED_ERROR,
      });
    });

    await freshKind(stack, "probe.wide");
  });

  it("leave a job a live worker claimed after the import started", async () => {
    if (stack === undefined) return;
    await freshKind(stack, "probe.wide");

    const importedFrom = Date.now() - 1000;

    await enqueue(stack, "probe.wide", 1);

    const probe = worker(stack, `restore-late-${unique()}`);
    const claim = await probe.claim(["probe.wide"]);

    if (claim.outcome !== "claimed") throw new Error("No probe job was claimed");

    expect(await settle(stack, importedFrom)).toEqual({ settled: 0 });
    expect(await jobOf(stack, claim.lease.jobId)).toMatchObject({ status: "running" });
    expect(await probe.finish(claim.lease, { outcome: "succeeded" })).toMatchObject({
      outcome: "settled",
      status: "succeeded",
    });

    await freshKind(stack, "probe.wide");
  });

  // Ends every session on the stack, so it runs last; the stack's other suites sign in afresh.
  it("end every session, more than one call's page, while an API key signs in again", async () => {
    if (stack === undefined) return;
    const person = await member(stack, "restore-person");
    const key = await serviceKey(stack);
    const before = await signIn(stack, "apiKey", { key });

    expect(await domainsAs(stack, before)).toEqual(expect.any(Array));

    const seeded = await runFunction(
      stack,
      internal.core.maintenanceProbe.seedSessions,
      { userId: person.userId, sessions: 250, tokens: 300 },
      Schema.declare(isSessionId),
    );

    const left = () =>
      runFunction(
        stack,
        internal.core.maintenanceProbe.left,
        { userId: person.userId, sessionId: seeded },
        Left,
      );

    expect(await left()).toEqual({ sessions: 251, tokens: 300 });
    expect(await runFunction(stack, internal.core.maintenance.endAllSessions, {}, Ended)).toEqual({
      ended: 100,
    });

    // Signed in after the restore began, so it stays.
    const after = await signIn(stack, "apiKey", { key });

    await eventually(
      "every session and its refresh tokens to end",
      async () => {
        const now = await left();

        return now.sessions === 0 && now.tokens === 0 ? now : null;
      },
      240_000,
    );

    expect(await refusal(person.signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(domainsAs(stack, before))).toBe("unauthenticated");
    expect(await domainsAs(stack, after)).toEqual(expect.any(Array));
    expect(await domainsAs(stack, await signIn(stack, "apiKey", { key }))).toEqual(
      expect.any(Array),
    );
  });
});
