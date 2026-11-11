import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { retrying } from "./jobs/driver";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one through `v.id("jobs")`, which checks it again whenever a test sends it.
const isJobId = (value: unknown): value is Id<"jobs"> => Schema.is(Schema.String)(value);

const Lease = Schema.Struct({ jobId: Schema.declare(isJobId), attempt: Schema.Finite });

type Lease = typeof Lease.Type;

const Claim = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("claimed"),
    lease: Lease,
    payload: Schema.Struct({ kind: Schema.String, trigger: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const Recorded = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    value: Schema.Struct({ backupId: Schema.String }),
  }),
  Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
]);

const Synced = Schema.Struct({ continueCursor: Schema.String, isDone: Schema.Boolean });

const Settled = Schema.Struct({ outcome: Schema.String });

interface Archive {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly trigger: "nightly" | "manual";
  readonly takenAt: number;
}

const finish = (core: CoreStack, lease: Lease) =>
  retrying(() =>
    runServer(core, api.core.jobs.worker.finish, { lease, end: { outcome: "succeeded" } }, Settled),
  );

/**
 * Claims backup job `jobId` as the stack's media server. Another backup it claims first, left by
 * an earlier run, it ends at once.
 */
const claimBackup = async (
  core: CoreStack,
  jobId: Id<"jobs">,
  leaseMs = 60_000,
  deadline = Date.now() + 120_000,
): Promise<Lease> => {
  const claim = await retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.claim,
      { kinds: ["server.backup"], workerId: `backups-${unique()}`, leaseMs },
      Claim,
    ),
  );

  if (claim.outcome === "claimed" && claim.lease.jobId === jobId) return claim.lease;

  if (Date.now() > deadline) throw new Error(`Timed out waiting for a claim of ${jobId}`);

  if (claim.outcome === "claimed") await finish(core, claim.lease);
  else await sleep(250);

  return claimBackup(core, jobId, leaseMs, deadline);
};

const record = (core: CoreStack, lease: Lease, fileName: string, sizeBytes = 10) =>
  retrying(() =>
    runServer(
      core,
      api.core.backups.record,
      { lease, fileName, sizeBytes, takenAt: Date.now() },
      Recorded,
    ),
  );

const sync = async (
  core: CoreStack,
  archives: ReadonlyArray<Archive>,
  cursor: string | null = null,
  pages = 1,
  listedAt = Date.now() + 60_000,
): Promise<number> => {
  const next = await retrying(() =>
    runServer(core, api.core.backups.sync, { archives: [...archives], cursor, listedAt }, Synced),
  );

  return next.isDone ? pages : sync(core, archives, next.continueCursor, pages + 1, listedAt);
};

const listAll = async (
  admin: Member,
  numItems = 1000,
  cursor: string | null = null,
  seen: ReadonlyArray<{ readonly fileName: string; readonly trigger: string }> = [],
  pages = 0,
): Promise<{ readonly rows: typeof seen; readonly pages: number }> => {
  const page = await admin.signedIn.client.query(api.core.server.backups.list, {
    paginationOpts: { numItems, cursor },
  });

  const rows = [...seen, ...page.page];

  return page.isDone
    ? { rows, pages: pages + 1 }
    : listAll(admin, numItems, page.continueCursor, rows, pages + 1);
};

const archive = (fileName: string, takenAt: number): Archive => ({
  fileName,
  sizeBytes: 1,
  trigger: "nightly",
  takenAt,
});

describe.skipIf(stack === undefined)("server backups", { timeout: 180_000 }, () => {
  it("show the backup queued or running for the whole job, to admins only", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "backups-active", "admin");
    const someone = await member(stack, "backups-active-member");
    const active = () => admin.signedIn.client.query(api.core.server.backups.active, {});

    expect(await refusal(someone.signedIn.client.query(api.core.server.backups.active, {}))).toBe(
      "forbidden",
    );

    const { jobId } = await admin.signedIn.client.mutation(api.core.server.backups.run, {});

    expect(await active()).toEqual({ jobId, status: "queued" });

    const lease = await claimBackup(stack, jobId);

    expect(await active()).toEqual({ jobId, status: "running" });

    await finish(stack, lease);

    expect(await active()).toBeNull();
  });

  it("cancel a backup only at the attempt named, after its lease lapsed and it was claimed again", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "backups-reclaim", "admin");
    const { jobId } = await admin.signedIn.client.mutation(api.core.server.backups.run, {});
    const Answer = Schema.Struct({ outcome: Schema.String });

    const cancelAt = (attempt: number) =>
      runFunction(stack, internal.core.jobs.admin.cancel, { jobId, attempt }, Answer);

    const first = await claimBackup(stack, jobId, 5000);

    await sleep(5500);
    await runFunction(
      stack,
      internal.core.jobs.leases.releaseExpired,
      {},
      Schema.Struct({ released: Schema.Finite, more: Schema.Boolean }),
    );

    const second = await claimBackup(stack, jobId);

    expect(second).toEqual({ jobId, attempt: first.attempt + 1 });
    expect(await cancelAt(first.attempt)).toEqual({ outcome: "movedOn" });
    expect(await admin.signedIn.client.query(api.core.server.backups.active, {})).toEqual({
      jobId,
      status: "running",
    });
    expect(await cancelAt(second.attempt)).toEqual({ outcome: "canceling" });
    await finish(stack, second);
  });

  it("record an archive under the job's lease, once, with the job's trigger", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "backups-admin", "admin");
    const { jobId } = await admin.signedIn.client.mutation(api.core.server.backups.run, {});

    expect(await admin.signedIn.client.mutation(api.core.server.backups.run, {})).toEqual({
      jobId,
    });

    const lease = await claimBackup(stack, jobId);
    const fileName = `snapshot-${unique()}.zip`;
    const first = await record(stack, lease, fileName);

    expect(first).toMatchObject({ outcome: "held" });
    expect(await record(stack, lease, fileName)).toEqual(first);
    expect(await refusal(record(stack, lease, "nested/name.zip"))).toBe("invalid_args");
    expect(await refusal(record(stack, lease, "x".repeat(256)))).toBe("invalid_args");
    expect(await refusal(record(stack, lease, "ok.zip", -1))).toBe("invalid_args");

    // A manual run while this one runs joins it.
    expect(await admin.signedIn.client.mutation(api.core.server.backups.run, {})).toEqual({
      jobId,
    });
    await finish(stack, lease);

    const afterFinish = `late-${unique()}.zip`;

    expect(await record(stack, lease, afterFinish)).toEqual({ outcome: "lost" });

    const canceled = await admin.signedIn.client.mutation(api.core.server.backups.run, {});

    expect(canceled.jobId).not.toBe(jobId);

    const canceledLease = await claimBackup(stack, canceled.jobId);

    await runFunction(
      stack,
      internal.core.jobs.admin.cancel,
      { jobId: canceled.jobId },
      Schema.Struct({ outcome: Schema.String }),
    );

    const afterCancel = `canceled-${unique()}.zip`;

    expect(await record(stack, canceledLease, afterCancel)).toEqual({ outcome: "canceled" });

    const { rows } = await listAll(admin);

    expect(rows).toContainEqual(expect.objectContaining({ fileName, trigger: "manual" }));
    expect(rows.map((row) => row.fileName)).not.toContain(afterFinish);
    expect(rows.map((row) => row.fileName)).not.toContain(afterCancel);

    const backupId = first.outcome === "held" ? first.value.backupId : "";

    expect(await runServer(stack, api.core.backups.file, { backupId }, Schema.Unknown)).toEqual({
      fileName,
    });
    expect(
      await runServer(stack, api.core.backups.file, { backupId: "nope" }, Schema.Unknown),
    ).toBeNull();

    await sync(stack, []);
  });

  it("sync the table to the archives on disk across pages, and list it newest first", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "backups-sync", "admin");
    const run = unique();
    const base = Date.now();

    // Two sets that interleave in time, so both pages hold rows of the old set.
    const old = Array.from({ length: 400 }, (_, n) => archive(`old-${run}-${n}.zip`, base + 2 * n));

    const fresh = Array.from({ length: 400 }, (_, n) =>
      archive(`fresh-${run}-${n}.zip`, base + 2 * n + 1),
    );

    await sync(stack, old);
    expect((await listAll(admin)).rows.length).toBe(400);

    expect(await sync(stack, fresh)).toBe(2);

    const { rows } = await listAll(admin);

    expect(rows.map((row) => row.fileName).toSorted()).toEqual(
      fresh.map((row) => row.fileName).toSorted(),
    );

    const few = fresh.slice(0, 5);

    await sync(stack, few);

    const paged = await listAll(admin, 2);

    expect(paged.pages).toBe(3);
    expect(paged.rows.map((row) => row.fileName)).toEqual(
      few.map((row) => row.fileName).toReversed(),
    );

    expect(
      await refusal(
        sync(
          stack,
          Array.from({ length: 501 }, (_, n) => archive(`${n}.zip`, n)),
        ),
      ),
    ).toBe("invalid_args");

    await sync(stack, []);
    expect((await listAll(admin)).rows).toEqual([]);
  });

  it("keep a row a backup recorded after the folder was listed", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "backups-late", "admin");
    const listedBefore = Date.now() - 60_000;
    const late = archive(`late-${unique()}.zip`, Date.now());

    await sync(stack, [late]);
    await sync(stack, [], null, 1, listedBefore);
    expect((await listAll(admin)).rows.map((row) => row.fileName)).toEqual([late.fileName]);

    await sync(stack, []);
    expect((await listAll(admin)).rows).toEqual([]);
  });

  it("refuse backups to a member", async () => {
    if (stack === undefined) return;
    const person = await member(stack, "backups-member");

    expect(
      await refusal(
        person.signedIn.client.query(api.core.server.backups.list, {
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toBe("forbidden");
    expect(await refusal(person.signedIn.client.mutation(api.core.server.backups.run, {}))).toBe(
      "forbidden",
    );
    expect(
      await refusal(
        runServerAs(
          stack,
          person.signedIn,
          api.core.backups.sync,
          { archives: [], cursor: null, listedAt: Date.now() },
          Synced,
        ),
      ),
    ).toBe("forbidden");
  });
});
