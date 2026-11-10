import { v } from "convex/values";

import { register } from "../../commands/core/libraries";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader } from "../_generated/server";
import { releaseClaims, takeWaiters } from "./folderClaims";
import { claimFolders, foldersOf, parseFolders, releaseFolders } from "./folders";
import { scanKindOf } from "./jobs/kinds";
import { progressOf } from "./jobs/machine";
import { cancel, enqueue } from "./jobs/queue";
import type { Enqueued, JobCtx } from "./jobs/store";
import { inOrder } from "./lib/inOrder";
import { GIVEN_NAME_MAX, requireGivenName } from "./lib/names";
import { requireServer } from "./permissions/authorize";
import { deleteGrantsOn, grantCreator, requireContent, visiblePage } from "./permissions/grants";
import { forgetItemCount, itemCount, schedulePurge } from "./scans";

const parseName = (typed: string): string =>
  requireGivenName(typed, `Name a library with 1 to ${GIVEN_NAME_MAX} printable characters`);

const libraryRef = (id: Id<"libraries">) => ({ type: "library", id }) as const;

const queueScan = async (ctx: JobCtx, library: Doc<"libraries">): Promise<Enqueued> => {
  const scan = await enqueue(ctx, { kind: scanKindOf(library.kind), libraryId: library._id });

  if (scan.created) await ctx.db.patch(library._id, { lastScan: scan.jobId });

  return scan;
};

const restartScan = async (ctx: JobCtx, library: Doc<"libraries">): Promise<Enqueued> => {
  const joined = await queueScan(ctx, library);
  const running = !joined.created && (await ctx.db.get(joined.jobId))?.status === "running";

  if (!running) return joined;

  await cancel(ctx, joined.jobId);

  return queueScan(ctx, library);
};

interface ScanShown {
  /** A failed scan's error may name the folders, which only managers see. */
  readonly error: boolean;
  /** Progress counts what a kid's restrictions may hide, so a kid sees none. */
  readonly progress: boolean;
}

const scanOf = async (db: DatabaseReader, jobId: Id<"jobs"> | null, shown: ScanShown) => {
  const job = jobId === null ? null : await db.get(jobId);

  if (job === null) return null;

  return {
    jobId: job._id,
    status: job.status,
    ...(shown.progress ? progressOf(job.work) : { done: null, total: null }),
    error: shown.error && job.status === "failed" ? job.error : null,
    finishedAt: job.status === "queued" || job.status === "running" ? null : job.finishedAt,
  };
};

/**
 * Makes a library of `kind` on `folders` with `creator` its first manager and queues its first
 * scan: the one way a library is made, for `create` and for an import that adds one (ADR 0024).
 * The caller decided that `creator` may point the server at its folders (`manageFolders`).
 */
export const makeLibrary = async (
  ctx: JobCtx,
  library: {
    readonly name: string;
    readonly kind: Doc<"libraries">["kind"];
    readonly folders: ReadonlyArray<string>;
    readonly creator: Id<"users">;
  },
): Promise<{ readonly libraryId: Id<"libraries">; readonly scanJobId: Id<"jobs"> }> => {
  const libraryId = await ctx.db.insert("libraries", {
    name: parseName(library.name),
    kind: library.kind,
    lastScan: null,
  });

  await claimFolders(ctx, libraryId, parseFolders(library.folders));
  await grantCreator(ctx, libraryRef(libraryId), library.creator);

  const doc = await ctx.db.get(libraryId);

  if (doc === null) throw new Error(`The library ${libraryId} made in this mutation is gone`);

  const first = await queueScan(ctx, doc);

  return { libraryId, scanJobId: first.jobId };
};

export const { create, list, get, rename, setFolders, scan, remove } = register({
  create: async (ctx, { name, kind, folders }, caller) => {
    requireServer(caller, "manageFolders");

    return makeLibrary(ctx, { name, kind, folders, creator: caller.userId });
  },
  list: async (ctx, { paginationOpts }, caller) => {
    const page = await visiblePage(ctx, caller, "library", paginationOpts);

    return {
      ...page,
      page: page.page.map(({ doc, level }) => ({
        libraryId: doc._id,
        name: doc.name,
        kind: doc.kind,
        level,
      })),
    };
  },
  get: async (ctx, { libraryId }, caller) => {
    const { doc, level } = await requireContent(ctx, caller, "view", libraryRef(libraryId));
    const manager = level === "manage";
    const counts = caller.restrictions === null;

    return {
      libraryId: doc._id,
      name: doc.name,
      kind: doc.kind,
      level,
      items: counts ? await itemCount(ctx.db, doc._id) : null,
      folders: manager ? [...(await foldersOf(ctx.db, doc._id))] : null,
      scan: await scanOf(ctx.db, doc.lastScan, { error: manager, progress: counts }),
    };
  },
  rename: async (ctx, { libraryId, name }, caller) => {
    const { doc } = await requireContent(ctx, caller, "manage", libraryRef(libraryId));

    await ctx.db.patch(doc._id, { name: parseName(name) });

    return null;
  },
  setFolders: async (ctx, { libraryId, folders }, caller) => {
    const { doc } = await requireContent(ctx, caller, "manage", libraryRef(libraryId));

    requireServer(caller, "manageFolders");

    const { added, removed } = await claimFolders(ctx, doc._id, parseFolders(folders));

    if (added.length === 0 && removed.length === 0) return { scanJobId: null };

    await releaseClaims(ctx, doc._id, removed);

    if (removed.length > 0) await schedulePurge(ctx, doc);

    return { scanJobId: (await restartScan(ctx, doc)).jobId };
  },
  scan: async (ctx, { libraryId }, caller) => {
    const { doc } = await requireContent(ctx, caller, "edit", libraryRef(libraryId));

    return queueScan(ctx, doc);
  },
  remove: async (ctx, { libraryId }, caller) => {
    const { doc } = await requireContent(ctx, caller, "manage", libraryRef(libraryId));

    if (doc.lastScan !== null) await cancel(ctx, doc.lastScan);

    await releaseFolders(ctx, doc._id);
    await releaseClaims(ctx, doc._id, null);
    await forgetItemCount(ctx.db, doc._id);
    await deleteGrantsOn(ctx, libraryRef(doc._id));
    await ctx.db.delete(doc._id);
    await schedulePurge(ctx, doc);

    return null;
  },
});

/**
 * Queues a scan of up to 16 libraries that were refused a folder `ownerLibraryId` claimed first,
 * now that it let a claim go (ADR 0024, "Folder identity"), and schedules itself again while more
 * wait. A library that still overlaps is refused again and waits again.
 */
export const wakeWaiting = internalMutation({
  args: { ownerLibraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { ownerLibraryId }) => {
    const { libraryIds, more } = await takeWaiters(ctx, ownerLibraryId);

    await inOrder(libraryIds, async (libraryId) => {
      const library = await ctx.db.get(libraryId);

      if (library !== null) await queueScan(ctx, library);
    });

    if (more) {
      await ctx.scheduler.runAfter(0, internal.core.libraries.wakeWaiting, { ownerLibraryId });
    }

    return null;
  },
});
