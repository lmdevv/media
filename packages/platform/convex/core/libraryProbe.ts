import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { level } from "../../commands/access";
import { callerScope, contentDomain } from "../../commands/scopes";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { DatabaseReader } from "../_generated/server";
import { callerOfSession } from "./auth/caller";
import { claimFolders } from "./folders";
import { lease } from "./jobs/model";
import { fail } from "./lib/errors";
import { inOrder } from "./lib/inOrder";
import { paginate } from "./lib/paginate";
import { serverMutation } from "./lib/serverFacing";
import { grantCreator, requireItems } from "./permissions/grants";
import { contentActions, ratingOf } from "./permissions/policy";
import type { ContentFacts } from "./permissions/policy";
import { purgeStep, scanAnswer, withLibraryItems, withScanLease } from "./scans";

/**
 * The test seam for a domain's library items until the movies port: the scanner callbacks a
 * domain writes, over `probeItems`, and loaders that decide on items as a title list will.
 */

const SEED_MAX = 1000;

const BATCH_MAX = 500;

const KNOWN_PAGE = 1000;

const scannedFile = v.object({ path: v.string(), size: v.number(), mtime: v.number() });

const factsOf = (library: Doc<"libraries">, item: Doc<"probeItems">): ContentFacts =>
  library.kind === "movies"
    ? { domain: "movies", rating: ratingOf(item.age) }
    : { domain: "music", explicit: item.explicit };

const itemAt = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  path: string,
): Promise<Doc<"probeItems"> | null> =>
  db
    .query("probeItems")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
    .unique();

const checkBatch = (count: number): void => {
  if (count > BATCH_MAX) throw new Error(`A batch holds at most ${BATCH_MAX} files; got ${count}`);
};

/**
 * Makes libraries managed by `managerId`, each with a folder of its own and rated items in it,
 * and queues no scan.
 *
 * @throws Error when asked for none or more than 1,000 libraries.
 */
export const seed = internalMutation({
  args: {
    managerId: v.id("users"),
    libraries: v.array(
      v.object({
        name: v.string(),
        kind: contentDomain,
        items: v.array(
          v.object({
            name: v.string(),
            age: v.union(v.number(), v.null()),
            explicit: v.boolean(),
          }),
        ),
      }),
    ),
  },
  returns: v.array(
    v.object({ libraryId: v.id("libraries"), itemIds: v.array(v.id("probeItems")) }),
  ),
  handler: async (ctx, { managerId, libraries }) => {
    if (libraries.length === 0 || libraries.length > SEED_MAX) {
      throw new Error(`seed makes 1 to ${SEED_MAX} libraries; got ${libraries.length}`);
    }

    const seeded = await inOrder(libraries, async ({ name, kind, items }) => {
      const libraryId = await ctx.db.insert("libraries", { name, kind, lastScan: null });
      const folder = `/probe/${libraryId}`;

      await claimFolders(ctx, libraryId, [folder]);
      await grantCreator(ctx, { type: "library", id: libraryId }, managerId);

      const itemIds = await withLibraryItems(ctx, libraryId, async () => {
        const inserted = await Promise.all(
          items.map(async (item) =>
            ctx.db.insert("probeItems", {
              libraryId,
              path: `${folder}/${item.name}`,
              size: 0,
              mtime: 0,
              age: item.age,
              explicit: item.explicit,
            }),
          ),
        );

        return { value: inserted, added: inserted.length, removed: 0 };
      });

      return { libraryId, itemIds };
    });

    return [...seeded];
  },
});

const opened = v.object({ itemId: v.id("probeItems"), path: v.string(), level });

/** Opens an item as a session would through a command that declares `scope`. */
export const open = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    action: v.union(...contentActions.map((action) => v.literal(action))),
    itemId: v.id("probeItems"),
  },
  returns: opened,
  handler: async (ctx, { sessionId, scope, action, itemId }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const item = (await ctx.db.get(itemId)) ?? fail("not_found", "No such item");
    const gate = await requireItems(ctx, caller, action, item.libraryId);

    if (!gate.admits(factsOf(gate.library, item))) fail("not_found", "No such item");

    return { itemId: item._id, path: item.path, level: gate.level };
  },
});

/** One page of a library's items a session sees, by path, as a title list would page them. */
export const page = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    libraryId: v.id("libraries"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(opened),
  handler: async (ctx, { sessionId, scope, libraryId, paginationOpts }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const gate = await requireItems(ctx, caller, "view", libraryId);

    const found = await paginate(
      ctx.db,
      {
        table: "probeItems",
        index: "by_library_path",
        range: (q) => q.eq("libraryId", libraryId),
      },
      paginationOpts,
    );

    return {
      ...found,
      page: found.page
        .filter((item) => gate.admits(factsOf(gate.library, item)))
        .map((item) => ({ itemId: item._id, path: item.path, level: gate.level })),
    };
  },
});

/**
 * A page of what the library lists inside its folders now, from `cursor`, so a scan can skip
 * unchanged files and find missing ones. Rows of a removed folder are the purge's to delete.
 */
export const known = serverMutation({
  args: { lease, kind: contentDomain, cursor: v.union(v.string(), v.null()) },
  returns: scanAnswer(
    v.object({
      files: v.array(scannedFile),
      continueCursor: v.string(),
      isDone: v.boolean(),
    }),
  ),
  handler: (ctx, { lease: held, kind, cursor }) =>
    withScanLease(ctx, kind, held, async (scan) => {
      const found = await paginate(
        ctx.db,
        {
          table: "probeItems",
          index: "by_library_path",
          range: (q) => q.eq("libraryId", scan.library._id),
        },
        { numItems: KNOWN_PAGE, cursor },
      );

      return {
        value: {
          files: found.page
            .filter((item) => scan.keeps(item.path))
            .map(({ path, size, mtime }) => ({ path, size, mtime })),
          continueCursor: found.continueCursor,
          isDone: found.isDone,
        },
        added: 0,
        removed: 0,
      };
    }),
});

/** Writes up to 500 files a scan found: inserts the new ones and updates the changed ones. */
export const upsert = serverMutation({
  args: { lease, kind: contentDomain, files: v.array(scannedFile) },
  returns: scanAnswer(v.object({ inserted: v.number() })),
  handler: (ctx, { lease: held, kind, files }) =>
    withScanLease(ctx, kind, held, async (scan) => {
      checkBatch(files.length);
      scan.admit(files.map((file) => file.path));

      const inserted = await Promise.all(
        files.map(async (file): Promise<number> => {
          const row = await itemAt(ctx.db, scan.library._id, file.path);

          if (row === null) {
            await ctx.db.insert("probeItems", {
              libraryId: scan.library._id,
              ...file,
              age: null,
              explicit: false,
            });

            return 1;
          }

          if (row.size !== file.size || row.mtime !== file.mtime) {
            await ctx.db.patch(row._id, { size: file.size, mtime: file.mtime });
          }

          return 0;
        }),
      );

      const added = inserted.reduce((sum, one) => sum + one, 0);

      return { value: { inserted: added }, added, removed: 0 };
    }),
});

/** Deletes up to 500 files a scan did not find; a path the library does not list is no change. */
export const missing = serverMutation({
  args: { lease, kind: contentDomain, paths: v.array(v.string()) },
  returns: scanAnswer(v.object({ removed: v.number() })),
  handler: (ctx, { lease: held, kind, paths }) =>
    withScanLease(ctx, kind, held, async (scan) => {
      checkBatch(paths.length);

      const rows = await Promise.all(
        scan.admit(paths).map(async (path) => itemAt(ctx.db, scan.library._id, path)),
      );

      const gone = rows.flatMap((row) => (row === null ? [] : [row]));

      await Promise.all(gone.map((row) => ctx.db.delete(row._id)));

      return { value: { removed: gone.length }, added: 0, removed: gone.length };
    }),
});

/** Both domains' purge until the movies port: deletes 500 rows a page that no folder keeps. */
export const purge = internalMutation({
  args: { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor }) => {
    const next = await purgeStep(ctx, libraryId, async (scope) => {
      const found = await paginate(
        ctx.db,
        {
          table: "probeItems",
          index: "by_library_path",
          range: (q) => q.eq("libraryId", libraryId),
        },
        { numItems: BATCH_MAX, cursor },
      );

      const leaving = found.page.filter((item) => !scope.keeps(item.path));

      await Promise.all(leaving.map((item) => ctx.db.delete(item._id)));

      return {
        value: found.isDone ? null : found.continueCursor,
        added: 0,
        removed: leaving.length,
      };
    });

    if (next !== null) {
      await ctx.scheduler.runAfter(0, internal.core.libraryProbe.purge, {
        libraryId,
        cursor: next,
      });
    }

    return null;
  },
});

/** Whether any item of `libraryId` is left, removed or not. */
export const hasItems = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.boolean(),
  handler: async (ctx, { libraryId }) =>
    (await ctx.db
      .query("probeItems")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .first()) !== null,
});
