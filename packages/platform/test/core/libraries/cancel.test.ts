import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { share } from "../../probe";
import { runServer, runServerAs } from "../../service";
import { refusal } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { claimJob, finishJob, moviesLibrary, upsert } from "../../movies/catalog";
import type { Lease } from "../../movies/catalog";
import { startImport } from "../../movies/importing";
import { movieFile } from "../../movies/scanned";
import { retrying } from "../jobs/driver";

const stack = coreStackFromEnvFile();

const Answer = Schema.Struct({ outcome: Schema.String });

const report = (core: CoreStack, lease: Lease, done: number, total: number, message: string) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.report,
      { lease, leaseMs: 60_000, message, progress: { done, total } },
      Answer,
    ),
  );

const finishWith = (core: CoreStack, lease: Lease) =>
  retrying(() =>
    runServer(core, api.core.jobs.worker.finish, { lease, end: { outcome: "succeeded" } }, Answer),
  );

const cancel = (who: Member, jobId: Id<"jobs">) =>
  who.signedIn.client.mutation(api.core.libraries.cancelScan, { jobId });

const scanOf = async (who: Member, libraryId: Id<"libraries">) =>
  (await who.signedIn.client.query(api.core.libraries.get, { libraryId })).scan;

const Watched = Schema.Struct({
  page: Schema.Array(
    Schema.Struct({ libraryId: Schema.String, folders: Schema.Array(Schema.String) }),
  ),
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

const watchedFolders = async (
  core: CoreStack,
  cursor: string | null = null,
  seen: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> => {
  const page = await runServer(
    core,
    api.core.scans.watched,
    { kind: "movies", paginationOpts: { numItems: 64, cursor } },
    Watched,
  );

  const next = new Map([...seen, ...page.page.map((row) => [row.libraryId, row.folders] as const)]);

  return page.isDone ? next : watchedFolders(core, page.continueCursor, next);
};

describe.skipIf(stack === undefined)("cancelling scans and imports", { timeout: 300_000 }, () => {
  it("cancel the scan named, fenced by its attempt, for people who may edit the library", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "cancel-admin", "admin");
    const editor = await member(stack, "cancel-editor");
    const viewer = await member(stack, "cancel-viewer");
    const outsider = await member(stack, "cancel-outsider");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Cancels");
    const root = roots[0] ?? "";

    await share(admin, libraryId, { kind: "user", userId: editor.userId }, "edit");
    await share(admin, libraryId, { kind: "user", userId: viewer.userId }, "view");

    const first = await claimJob(stack, "movies.scan", scanJobId);
    const before = Date.now();

    await report(stack, first, 1, 4, "probing");

    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: scanJobId,
      status: "running",
      done: 1,
      total: 4,
      message: "probing",
    });
    expect((await scanOf(editor, libraryId))?.startedAt).toBeLessThanOrEqual(before);

    expect(await refusal(cancel(viewer, scanJobId))).toBe("forbidden");
    expect(await refusal(cancel(outsider, scanJobId))).toBe("not_found");

    await finishJob(stack, first);
    expect(await cancel(editor, scanJobId)).toEqual({ outcome: "finished", status: "succeeded" });
    expect(await scanOf(editor, libraryId)).toMatchObject({ status: "succeeded" });

    const queued = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });

    expect(await cancel(editor, queued.jobId)).toEqual({ outcome: "finished", status: "canceled" });
    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: queued.jobId,
      status: "canceled",
    });

    const running = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });
    const lease = await claimJob(stack, "movies.scan", running.jobId);

    expect(await cancel(editor, running.jobId)).toEqual({ outcome: "canceling" });
    expect(await cancel(editor, running.jobId)).toEqual({ outcome: "canceling" });
    expect(await scanOf(editor, libraryId)).toMatchObject({ status: "running", canceling: true });

    expect(await upsert(stack, lease, [movieFile(join(root, "late.mkv"))])).toEqual({
      outcome: "canceled",
    });
    expect(await finishWith(stack, lease)).toEqual({ outcome: "canceled" });
    expect(await report(stack, lease, 4, 4, "done")).toEqual({ outcome: "canceled" });
    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: running.jobId,
      status: "canceled",
      startedAt: null,
    });
    expect(await cancel(editor, running.jobId)).toEqual({
      outcome: "finished",
      status: "canceled",
    });

    const next = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });

    expect(next.jobId).not.toBe(running.jobId);
    expect(await cancel(editor, running.jobId)).toEqual({
      outcome: "finished",
      status: "canceled",
    });
    expect(await scanOf(editor, libraryId)).toMatchObject({ jobId: next.jobId, status: "queued" });

    const backup = await admin.signedIn.client.mutation(api.core.server.backups.run, {});

    expect(await refusal(cancel(admin, backup.jobId))).toBe("not_found");

    await cancel(admin, next.jobId);
    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("cancel an import for its owners and admins, fenced by its attempt", async () => {
    if (stack === undefined) return;

    const owner = await member(stack, "cancel-import-admin", "admin");
    const someone = await member(stack, "cancel-import-member");
    const serverId = `cancel-${Date.now()}`;
    const started = await startImport(stack, owner, { serverId });

    const cancelImport = (who: Member) =>
      who.signedIn.client.mutation(api.movies.imports.cancel, { importId: started.importId });

    const run = () =>
      owner.signedIn.client.query(api.movies.imports.get, { importId: started.importId });

    expect((await run()).job).toMatchObject({ status: "queued", startedAt: null });
    expect(await refusal(cancelImport(someone))).toBe("forbidden");

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    expect((await run()).job.startedAt).toBeGreaterThan(0);
    expect(await cancelImport(owner)).toEqual({ outcome: "canceling" });
    expect(await finishWith(stack, lease)).toEqual({ outcome: "canceled" });
    expect((await run()).job).toMatchObject({ status: "canceled", startedAt: null });
    expect(await cancelImport(owner)).toEqual({ outcome: "finished", status: "canceled" });

    const again = await startImport(stack, owner, { serverId });

    expect(again.created).toBe(true);
    expect(await cancelImport(owner)).toEqual({ outcome: "finished", status: "canceled" });
    expect(
      (await owner.signedIn.client.query(api.movies.imports.get, { importId: again.importId })).job
        .status,
    ).toBe("queued");

    await owner.signedIn.client.mutation(api.movies.imports.cancel, { importId: again.importId });
  });

  it("tell the server every movies library's folders, and only the server", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "watched-admin", "admin");
    const { libraryId, roots } = await moviesLibrary(admin, "Watched", 2);

    expect((await watchedFolders(stack)).get(libraryId)?.toSorted()).toEqual([...roots].toSorted());
    expect(
      await refusal(
        runServerAs(
          stack,
          admin.signedIn,
          api.core.scans.watched,
          { kind: "movies", paginationOpts: { numItems: 10, cursor: null } },
          Watched,
        ),
      ),
    ).toBe("forbidden");

    const scan = await scanOf(admin, libraryId);

    if (scan !== null) {
      await admin.signedIn.client.mutation(api.core.libraries.cancelScan, { jobId: scan.jobId });
    }

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });

    expect((await watchedFolders(stack)).has(libraryId)).toBe(false);
  });
});
