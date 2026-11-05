import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Validator } from "convex/values";

import { contentDomain } from "../../commands/scopes";
import type { ContentDomain } from "../../commands/scopes";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { foldersOf, isInside, isPlainPath } from "./folders";
import { scanKindOf } from "./jobs/kinds";
import { cancel } from "./jobs/queue";
import { lease } from "./jobs/model";
import type { Lease } from "./jobs/model";
import { applyEvent } from "./jobs/store";
import type { JobCtx } from "./jobs/store";
import { deleteCounter, incrementCounter, readCounter } from "./lib/counters";
import { serverMutation, serverQuery } from "./lib/serverFacing";

const itemsCounter = (libraryId: Id<"libraries">): string => `libraryItems:${libraryId}`;

/**
 * What a write on a library's items did: its value, and how many counted rows it inserted and
 * deleted. A row it found and updated counts as neither.
 */
export interface Counted<Value> {
  readonly value: Value;
  readonly added: number;
  readonly removed: number;
}

const moveCount = async <Value>(
  db: MutationCtx["db"],
  libraryId: Id<"libraries">,
  counted: Counted<Value>,
): Promise<Value> => {
  const { added, removed } = counted;

  if (![added, removed].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error(`A write counts whole rows added and removed; got ${added} and ${removed}`);
  }

  if (added !== removed) await incrementCounter(db, itemsCounter(libraryId), added - removed);

  return counted.value;
};

/** How many items a library holds: one counter, read from at most 16 shard rows. */
export const itemCount = (db: DatabaseReader, libraryId: Id<"libraries">): Promise<number> =>
  readCounter(db, itemsCounter(libraryId));

/** Deletes the count of a library that is being deleted; its purge then counts nothing. */
export const forgetItemCount = (db: MutationCtx["db"], libraryId: Id<"libraries">): Promise<void> =>
  deleteCounter(db, itemsCounter(libraryId));

/**
 * Runs a write on the items of `libraryId` that no scan holds, such as an import, and moves the
 * library's count by what it reports, in this mutation.
 *
 * @throws Error when the library is gone, which only a defect in the caller gives.
 */
export const withLibraryItems = async <Value>(
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
  write: (library: Doc<"libraries">) => Promise<Counted<Value>>,
): Promise<Value> => {
  const library = await ctx.db.get(libraryId);

  if (library === null) throw new Error(`No library ${libraryId} to write items to`);

  return moveCount(ctx.db, libraryId, await write(library));
};

/** A scan the caller's lease holds, and the library it scans. */
export interface HeldScan {
  readonly jobId: Id<"jobs">;
  readonly library: Doc<"libraries">;
  readonly folders: ReadonlyArray<string>;
  /** Whether `path` lies in one of the library's folders now. */
  readonly keeps: (path: string) => boolean;
  /**
   * The paths, when each is absolute, without empty, `.`, or `..` parts, and inside one of the
   * library's folders.
   *
   * @throws Error on any other path: a scanner defect, because a change of folders cancels a
   * running scan before its next call.
   */
  readonly admit: (paths: ReadonlyArray<string>) => ReadonlyArray<string>;
}

/** What a scanner callback answers: its value while the lease holds, or why the worker stops. */
export type ScanAnswer<Value> =
  | { readonly outcome: "held"; readonly value: Value }
  | { readonly outcome: "canceled" }
  | { readonly outcome: "lost" };

/** `ScanAnswer` as a Convex validator, for a callback's `returns`. */
export const scanAnswer = <Value extends Validator<unknown, "required", string>>(value: Value) =>
  v.union(
    v.object({ outcome: v.literal("held"), value }),
    v.object({ outcome: v.literal("canceled") }),
    v.object({ outcome: v.literal("lost") }),
  );

const keepsIn =
  (folders: ReadonlyArray<string>) =>
  (path: string): boolean =>
    folders.some((folder) => isInside(path, folder));

const heldScan = (
  jobId: Id<"jobs">,
  library: Doc<"libraries">,
  folders: ReadonlyArray<string>,
): HeldScan => {
  const keeps = keepsIn(folders);

  return {
    jobId,
    library,
    folders,
    keeps,
    admit: (paths) => {
      const outside = paths.find((path) => !isPlainPath(path) || !keeps(path));

      if (outside !== undefined) {
        throw new Error(`${outside} is not a path inside the library's folders`);
      }

      return paths;
    },
  };
};

/**
 * The lease check every scanner callback runs first, in its own mutation, and the only way to
 * write a library's items under a scan. It applies the `check` event through `applyEvent`, so a
 * canceled job ends on this call and frees its slot, and a call from an older attempt answers
 * `lost`. It then reads the library and its folders, runs `write`, and moves the library's count
 * by what `write` reports, in this same mutation. A canceled attempt therefore writes nothing
 * after its cancel commits, which is what lets a library's new scan start while the old one's
 * worker has not yet stopped.
 *
 * @throws Error when the lease is a scan of another domain's library, which only a defect gives.
 */
export const withScanLease = async <Value>(
  ctx: JobCtx,
  kind: ContentDomain,
  held: Lease,
  write: (scan: HeldScan) => Promise<Counted<Value>>,
): Promise<ScanAnswer<Value>> => {
  const job = await ctx.db.get(held.jobId);

  if (job === null) return { outcome: "lost" };

  const { payload } = job;

  if (payload.kind !== scanKindOf(kind)) {
    throw new Error(`A ${kind} scan callback got the lease of a ${payload.kind} job`);
  }

  const checked = await applyEvent(ctx, job, { type: "check", lease: held });

  if (!checked.ok) {
    if (checked.refused === "canceled" || checked.refused === "lost") {
      return { outcome: checked.refused };
    }

    throw new Error(`A lease check was refused as ${checked.refused}`);
  }

  if (checked.next.status === "canceled") return { outcome: "canceled" };

  const library = await ctx.db.get(payload.libraryId);

  if (library === null) {
    await cancel(ctx, job._id);

    const canceling = await ctx.db.get(job._id);

    if (canceling !== null) await applyEvent(ctx, canceling, { type: "check", lease: held });

    return { outcome: "canceled" };
  }

  const folders = await foldersOf(ctx.db, library._id);
  const counted = await write(heldScan(job._id, library, folders));
  const value = await moveCount(ctx.db, library._id, counted);

  return { outcome: "held", value };
};

/** What a purge may delete: the library's rows that no folder of it holds now. */
export interface PurgeScope {
  readonly libraryId: Id<"libraries">;
  /** Whether a row at `path` stays: inside a current folder. Never, once the library is gone. */
  readonly keeps: (path: string) => boolean;
}

/**
 * One page of a domain's purge of a library's items: `deletePage` deletes up to a page of rows
 * that `scope` does not keep and says how many. While the library exists, its count moves by
 * them in this mutation; a deleted library's count is already gone. Reads the library and its
 * folders again on every page, so a folder added back mid-purge keeps its rows.
 */
export const purgeStep = async <Value>(
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
  deletePage: (scope: PurgeScope) => Promise<Counted<Value>>,
): Promise<Value> => {
  const library = await ctx.db.get(libraryId);
  const keeps = library === null ? () => false : keepsIn(await foldersOf(ctx.db, libraryId));
  const counted = await deletePage({ libraryId, keeps });

  return library === null ? counted.value : moveCount(ctx.db, libraryId, counted);
};

type PurgeHook = FunctionReference<
  "mutation",
  "internal",
  { libraryId: Id<"libraries">; cursor: string | null },
  null
>;

const purgeHooks = {
  movies: internal.core.libraryProbe.purge,
  music: internal.core.libraryProbe.purge,
} satisfies { readonly [Kind in ContentDomain]: PurgeHook };

/** Schedules the purge of the library's items outside its folders, or of all once it is gone. */
export const schedulePurge = async (
  ctx: Pick<MutationCtx, "scheduler">,
  library: Pick<Doc<"libraries">, "_id" | "kind">,
): Promise<void> => {
  await ctx.scheduler.runAfter(0, purgeHooks[library.kind], {
    libraryId: library._id,
    cursor: null,
  });
};

/**
 * Whether any library of `kind` exists: one index entry. A domain's cron returns at once when it
 * answers false, so a domain with no libraries does no work.
 */
export const hasLibraries = async (db: DatabaseReader, kind: ContentDomain): Promise<boolean> =>
  (await db
    .query("libraries")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .first()) !== null;

/**
 * Which domains have a library, one index entry each. The server runs a domain's workers only
 * while it has one.
 */
export const domains = serverQuery({
  args: {},
  returns: v.array(v.object({ kind: contentDomain, hasLibraries: v.boolean() })),
  handler: (ctx) =>
    Promise.all(
      contentDomain.members.map(async ({ value: kind }) => ({
        kind,
        hasLibraries: await hasLibraries(ctx.db, kind),
      })),
    ),
});

/**
 * The scanner's first call after it claims a scan: the library and the folders to walk, under the
 * lease. A queued scan reads the folders here, so a change of folders before it starts needs no
 * new scan.
 */
export const target = serverMutation({
  args: { lease, kind: contentDomain },
  returns: scanAnswer(v.object({ libraryId: v.id("libraries"), folders: v.array(v.string()) })),
  handler: (ctx, { lease: held, kind }) =>
    withScanLease(ctx, kind, held, async (scan) => ({
      value: { libraryId: scan.library._id, folders: [...scan.folders] },
      added: 0,
      removed: 0,
    })),
});
