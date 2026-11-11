import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { contentDomain } from "../../commands/scopes";
import type { ContentDomain } from "../../commands/scopes";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { claimIdentities, ownershipOf, parseClaim } from "./folderClaims";
import { FOLDER_DEPTH_MAX, foldersOf, isInside, isPlainPath } from "./folders";
import { scanKindOf } from "./jobs/kinds";
import { withJobLease, leaseAnswer } from "./jobs/held";
import type { LeaseAnswer } from "./jobs/held";
import { cancel, enqueue } from "./jobs/queue";
import { lease } from "./jobs/model";
import type { Lease } from "./jobs/model";
import { applyEvent } from "./jobs/store";
import type { Enqueued, JobCtx } from "./jobs/store";
import { deleteCounter, incrementCounter, readCounter } from "./lib/counters";
import { fail } from "./lib/errors";
import { inOrder } from "./lib/inOrder";
import { paginate } from "./lib/paginate";
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

/**
 * Queues a scan of `library` with its kind's dedupe, so a scan already queued or running is
 * joined, and points `lastScan` at a scan this made: the one way a scan is queued, for a manager's
 * scan, a change of folders, a wait that ended, and a file that changed (ADR 0024). A `full` scan
 * reads every file again, as a manager may ask; a scan already queued or running is joined
 * whatever its mode, as old movies' scan did.
 */
export const queueScan = async (
  ctx: JobCtx,
  library: Doc<"libraries">,
  mode: "incremental" | "full" = "incremental",
): Promise<Enqueued> => {
  const kind = scanKindOf(library.kind);

  const scan = await enqueue(
    ctx,
    mode === "full" ? { kind, libraryId: library._id, mode } : { kind, libraryId: library._id },
  );

  if (scan.created) await ctx.db.patch(library._id, { lastScan: scan.jobId });

  return scan;
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
 * Whether a scanner callback needs the library to own every folder it scans (ADR 0024, "Folder
 * identity"). Every write does; `target` and `claimFolders` come before the claim.
 */
type Fence = "owned" | "beforeClaim";

/**
 * The lease check every scanner callback runs first, in its own mutation, and the only way to
 * write a library's items under a scan. It runs `withJobLease`, so a canceled job ends on this
 * call and frees its slot, and a call from an older attempt answers `lost`. It then reads the
 * library and its folders and, unless `fence` is `beforeClaim`, its claims, one range of at most
 * 16: a library that does not own every folder it has, because an older claim took one or it
 * never claimed them, has its scan canceled and the call answers `canceled`, as for a deleted
 * library. Otherwise it runs `write` and moves the library's count by what `write` reports, in
 * this same mutation. A canceled attempt therefore writes nothing after its cancel commits, which
 * is what lets a library's new scan start while the old one's worker has not yet stopped, and an
 * evicted scan writes nothing after the eviction commits: the eviction writes the claim this
 * reads, so Convex runs the two one after the other.
 *
 * @throws Error when the lease is a scan of another domain's library, which only a defect gives.
 */
export const withScanLease = <Value>(
  ctx: JobCtx,
  kind: ContentDomain,
  held: Lease,
  write: (scan: HeldScan) => Promise<Counted<Value>>,
  fence: Fence = "owned",
): Promise<LeaseAnswer<Value>> =>
  withJobLease(ctx, [scanKindOf(kind)], held, async (job) => {
    const stop = async (): Promise<LeaseAnswer<Value>> => {
      await cancel(ctx, job.jobId, null);

      const canceling = await ctx.db.get(job.jobId);

      if (canceling !== null) await applyEvent(ctx, canceling, { type: "check", lease: held });

      return { outcome: "canceled" };
    };

    const library = await ctx.db.get(job.payload.libraryId);

    if (library === null) return stop();

    const folders = await foldersOf(ctx.db, library._id);

    if (fence === "owned") {
      const ownership = await ownershipOf(ctx.db, library._id);

      if (!folders.every(ownership.owns)) return stop();
    }

    const counted = await write(heldScan(job.jobId, library, folders));
    const value = await moveCount(ctx.db, library._id, counted);

    return { outcome: "held", value };
  });

/** What a purge may delete: the library's rows that no folder of it holds now. */
export interface PurgeScope {
  readonly libraryId: Id<"libraries">;
  /** Whether the library itself is gone; its counts went with it, so nothing moves them. */
  readonly gone: boolean;
  /**
   * Whether a row at `path` stays: inside a current folder that no older claim of another library
   * took. Never, once the library is gone.
   */
  readonly keeps: (path: string) => boolean;
}

/** Whether a path lies in one of the library's folders that it has not lost: three reads. */
const keptBy = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<(path: string) => boolean> => {
  const [folders, ownership] = await Promise.all([
    foldersOf(db, libraryId),
    ownershipOf(db, libraryId),
  ]);

  return keepsIn(folders.filter((folder) => !ownership.lost(folder)));
};

/**
 * One page of a domain's purge of a library's items: `deletePage` deletes up to a page of rows
 * that `scope` does not keep and says how many. While the library exists, its count moves by
 * them in this mutation; a deleted library's count is already gone. Reads the library, its
 * folders, and its claims again on every page, so a folder added back or claimed again mid-purge
 * keeps its rows. A folder the library never claimed keeps its rows, as an import writes them
 * before any scan.
 */
export const purgeStep = async <Value>(
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
  deletePage: (scope: PurgeScope) => Promise<Counted<Value>>,
): Promise<Value> => {
  const library = await ctx.db.get(libraryId);
  const keeps = library === null ? () => false : await keptBy(ctx.db, libraryId);
  const counted = await deletePage({ libraryId, gone: library === null, keeps });

  return library === null ? counted.value : moveCount(ctx.db, libraryId, counted);
};

type PurgeHook = FunctionReference<
  "mutation",
  "internal",
  { libraryId: Id<"libraries">; cursor: string | null },
  null
>;

const purgeHooks = {
  movies: internal.movies.purge.files,
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
 * Schedules the purge of a library that lost a folder to an older claim, which deletes its rows
 * there; `core/folderClaims.ts` schedules this when it takes a claim.
 */
export const purgeLibrary = internalMutation({
  args: { libraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { libraryId }) => {
    const library = await ctx.db.get(libraryId);

    if (library !== null) await schedulePurge(ctx, library);

    return null;
  },
});

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

/** Libraries one page of `watched` lists, each with its up to 16 folders. */
const WATCHED_PAGE_MAX = 64;

/**
 * Every movies library with its folders as recorded, a page at a time, for the server to watch
 * (ADR 0024). Movies only, whoever asks: the server rescans only movies on change, and another
 * domain's folders are not its to read. Folders, not approved roots, so a change under a folder
 * that links into a root names the library's own path and `changed` finds the library.
 */
export const watched = serverQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ libraryId: v.id("libraries"), folders: v.array(v.string()) }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const page = await paginate(
      ctx.db,
      { table: "libraries", index: "by_kind", range: (q) => q.eq("kind", "movies") },
      { ...paginationOpts, numItems: Math.min(paginationOpts.numItems, WATCHED_PAGE_MAX) },
    );

    const libraries = await Promise.all(
      page.page.map(async (library) => ({
        libraryId: library._id,
        folders: [...(await foldersOf(ctx.db, library._id))],
      })),
    );

    return { ...page, page: libraries };
  },
});

/**
 * The scanner's first call after it claims a scan: the library and the folders to walk, under the
 * lease. A queued scan reads the folders here, so a change of folders before it starts needs no
 * new scan.
 */
export const target = serverMutation({
  args: { lease, kind: contentDomain },
  returns: leaseAnswer(v.object({ libraryId: v.id("libraries"), folders: v.array(v.string()) })),
  handler: (ctx, { lease: held, kind }) =>
    withScanLease(
      ctx,
      kind,
      held,
      async (scan) => ({
        value: { libraryId: scan.library._id, folders: [...scan.folders] },
        added: 0,
        removed: 0,
      }),
      "beforeClaim",
    ),
});

/**
 * The scanner's second call, right after `target` and before any write: claims the library's
 * folders by what they are on disk (ADR 0024, "Folder identity"), so two libraries never reach one
 * folder through a link, a bind mount, or another spelling. `chain` holds the `<dev>:<ino>` of the
 * folder's real path and of each parent up to `/`, the folder first. `source` is the folder's
 * mount device and its path within that filesystem, or null when the server has no mount table.
 * `bootId` is the host boot the server read them in, kept for diagnosis. An overlap goes to the
 * claim that came first; a refusal names the first of the library's folders that an older claim
 * of another library reaches, or that another of its own folders reaches, and writes nothing but
 * the record that rescans this library when the other lets go; `rescans` says whether that record
 * exists, which it does not for a folder of its own nor past the cap on waits. The scanner then
 * stops. A younger claim this one takes loses its folder: its library's running scan is canceled,
 * its writes are refused from then on (`withScanLease`), and its purge deletes its rows there.
 *
 * @throws Error when the folders sent are not exactly the library's, or a chain or source is
 * malformed: a defect in the server, which sends what `target` answered.
 */
export const claimFolders = serverMutation({
  args: {
    lease,
    kind: contentDomain,
    bootId: v.union(v.string(), v.null()),
    folders: v.array(
      v.object({
        folder: v.string(),
        chain: v.array(v.string()),
        source: v.union(v.object({ device: v.string(), path: v.string() }), v.null()),
      }),
    ),
  },
  returns: leaseAnswer(
    v.union(
      v.object({ claimed: v.literal(true) }),
      v.object({ claimed: v.literal(false), folder: v.string(), rescans: v.boolean() }),
    ),
  ),
  handler: (ctx, { lease: held, kind, bootId, folders }) =>
    withScanLease(
      ctx,
      kind,
      held,
      async (scan) => ({
        value: await claimIdentities(
          ctx,
          scan.library._id,
          bootId,
          parseClaim(scan.folders, bootId, folders),
        ),
        added: 0,
        removed: 0,
      }),
      "beforeClaim",
    ),
});

/** The kinds a changed file rescans: those with a scanner on the server. Music has none yet. */
const RESCANNED_KINDS: ReadonlySet<ContentDomain> = new Set(["movies"]);

/** Most characters of a changed path, the longest path Linux takes. */
const CHANGED_PATH_CHARS_MAX = 4096;

/** Folders inside a changed path that one call reads; a scheduled call reads each next page. */
const INSIDE_PER_CALL = 64;

interface ChangedReach {
  /** The folders that could hold the path or be it, shallowest first. */
  readonly holders: ReadonlyArray<string>;
  /** The path whose inside holds the folders inside it, `""` for `/`, or null for none. */
  readonly inside: string | null;
}

/**
 * Where a changed path can meet a library's folders: the folders that could hold it, and the
 * start of the folders that could lie inside it. Both follow its plain parts: repeated and
 * trailing slashes and `.` parts are dropped, as a folder is written down, and a `..` part ends
 * them, since only the server's disk knows where it leads; past one, nothing lies inside the path.
 * A folder is at most 32 levels deep, so only that many leading parts can name one.
 */
const changedReach = (path: string): ChangedReach => {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const up = parts.indexOf("..");
  const plain = up === -1 ? parts : parts.slice(0, up);

  return {
    holders: plain
      .slice(0, FOLDER_DEPTH_MAX)
      .map((_, index) => `/${plain.slice(0, index + 1).join("/")}`),
    inside: up === -1 ? plain.map((part) => `/${part}`).join("") : null,
  };
};

/**
 * Queues a scan of each library of a kind with a scanner, joining one already queued or running.
 * Calls run one after another, as each enqueue reads and writes its kind's row.
 */
const rescan = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  libraryIds: ReadonlyArray<Id<"libraries">>,
): Promise<number> => {
  const queued = await inOrder([...new Set(libraryIds)], async (libraryId) => {
    const library = await ctx.db.get(libraryId);

    if (library === null || !RESCANNED_KINDS.has(library.kind)) return false;

    const scan = await queueScan(ctx, library);

    if (!scan.created && (await ctx.db.get(scan.jobId))?.status === "running") {
      await ctx.db.patch(library._id, { rescanAfter: true });
    }

    return true;
  });

  return queued.filter(Boolean).length;
};

const rescanInside = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  inside: string,
  cursor: string | null,
): Promise<number> => {
  const page = await paginate(
    ctx.db,
    {
      table: "libraryFolders",
      index: "by_path",
      range: (q) => q.gte("path", `${inside}/`).lt("path", `${inside}0`),
    },
    { numItems: INSIDE_PER_CALL, cursor },
  );

  const queued = await rescan(
    ctx,
    page.page.map((row) => row.libraryId),
  );

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.core.scans.changedInside, {
      inside,
      cursor: page.continueCursor,
    });
  }

  return queued;
};

/**
 * Rescans after a change on the server's disk (ADR 0024): `path` is an absolute path that changed,
 * a file or a folder, or a library root the server approved, which it sends at startup, on its
 * reconcile interval, after its watcher restarts, and when a root it polls changed. Queues a scan
 * of every movies library with a folder that is `path`, holds it, or lies inside it, and joins a
 * scan already queued or running, as every scan is queued (`queueScan`). Music has no scanner yet,
 * so its libraries are not queued. Answers how many libraries this call queued or joined; the
 * folders inside `path` past its first page are rescanned by scheduled calls. A file name need not
 * be plain, since a change event carries whatever name the disk has: the folders that hold it are
 * its plain leading parts (`changedReach`). Refuses with `invalid_args` a path that is not absolute
 * or is longer than 4,096 characters.
 */
export const changed = serverMutation({
  args: { path: v.string() },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, { path }) => {
    if (!path.startsWith("/") || path.length > CHANGED_PATH_CHARS_MAX) {
      return fail(
        "invalid_args",
        `A changed path is absolute and at most ${CHANGED_PATH_CHARS_MAX} characters`,
      );
    }

    const reach = changedReach(path);

    const holders = await Promise.all(
      reach.holders.map((folder) =>
        ctx.db
          .query("libraryFolders")
          .withIndex("by_path", (q) => q.eq("path", folder))
          .take(2),
      ),
    );

    const held = await rescan(
      ctx,
      holders.flat().map((row) => row.libraryId),
    );

    return {
      queued: held + (reach.inside === null ? 0 : await rescanInside(ctx, reach.inside, null)),
    };
  },
});

/** A later page of the folders inside a path `changed` was sent. */
export const changedInside = internalMutation({
  args: { inside: v.string(), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, { inside, cursor }) => {
    await rescanInside(ctx, inside, cursor);

    return null;
  },
});
