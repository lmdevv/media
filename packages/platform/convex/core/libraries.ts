import { register } from "../../commands/core/libraries";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { claimFolders, foldersOf, parseFolders, releaseFolders } from "./folders";
import { scanKindOf } from "./jobs/kinds";
import { progressOf } from "./jobs/machine";
import { cancel, enqueue } from "./jobs/queue";
import type { Enqueued, JobCtx } from "./jobs/store";
import { fail } from "./lib/errors";
import { requireServer } from "./permissions/authorize";
import { deleteGrantsOn, grantCreator, requireContent, visiblePage } from "./permissions/grants";
import { forgetItemCount, itemCount, schedulePurge } from "./scans";

const NAME_MAX = 64;

const parseName = (typed: string): string => {
  const name = typed.trim();

  return name.length === 0 || name.length > NAME_MAX
    ? fail("invalid_args", `Name a library with 1 to ${NAME_MAX} characters`)
    : name;
};

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

const scanOf = async (db: DatabaseReader, jobId: Id<"jobs"> | null) => {
  const job = jobId === null ? null : await db.get(jobId);

  if (job === null) return null;

  return {
    jobId: job._id,
    status: job.status,
    ...progressOf(job.work),
    error: job.status === "failed" ? job.error : null,
    finishedAt: job.status === "queued" || job.status === "running" ? null : job.finishedAt,
  };
};

export const { create, list, get, rename, setFolders, scan, remove } = register({
  create: async (ctx, { name, kind, folders }, caller) => {
    requireServer(caller, "manageFolders");

    const libraryId = await ctx.db.insert("libraries", {
      name: parseName(name),
      kind,
      lastScan: null,
    });

    await claimFolders(ctx, libraryId, parseFolders(folders));
    await grantCreator(ctx, libraryRef(libraryId), caller.userId);

    const { doc } = await requireContent(ctx, caller, "manage", libraryRef(libraryId));
    const first = await queueScan(ctx, doc);

    return { libraryId, scanJobId: first.jobId };
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

    return {
      libraryId: doc._id,
      name: doc.name,
      kind: doc.kind,
      level,
      items: await itemCount(ctx.db, doc._id),
      folders: level === "manage" ? [...(await foldersOf(ctx.db, doc._id))] : null,
      scan: await scanOf(ctx.db, doc.lastScan),
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
    await forgetItemCount(ctx.db, doc._id);
    await deleteGrantsOn(ctx, libraryRef(doc._id));
    await ctx.db.delete(doc._id);
    await schedulePurge(ctx, doc);

    return null;
  },
});
