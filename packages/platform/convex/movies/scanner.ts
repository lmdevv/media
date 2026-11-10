import { v } from "convex/values";

import { leaseAnswer } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import { paginate } from "../core/lib/paginate";
import { serverMutation } from "../core/lib/serverFacing";
import { withScanLease } from "../core/scans";
import { boundedItem, pathFits } from "./bounds";
import { NO_WORK, budgetFor, whileBudget, work } from "./budget";
import { MISSING_COST, markFileMissing, upsertCost, upsertScannedItem } from "./catalog";
import { moveTotals, sumMoved } from "./totals";
import { knownFile, scannedItem, upsertedFile } from "./validators";

/**
 * The most files or paths one call takes as arguments. How many of them it writes is the call's
 * work budget's to decide (`budget.ts`): it writes the leading ones whose worst case fits and
 * answers how many, and the server sends the rest again (ADR 0024).
 */
const BATCH_MAX = 500;

/** A scanner call's own work: the lease check, the library, its folders, and the counters. */
const CALL_COST = work(20, 8);

const KNOWN_PAGE = 1000;

const checkBatch = (count: number): void => {
  if (count > BATCH_MAX) throw new Error(`A batch holds at most ${BATCH_MAX} files; got ${count}`);
};

/**
 * A page of the files the library lists inside its folders now, missing ones included, from
 * `cursor`, so a scan can skip unchanged files and find missing ones. Rows of a removed folder
 * are the purge's to delete.
 */
export const known = serverMutation({
  args: { lease, cursor: v.union(v.string(), v.null()) },
  returns: leaseAnswer(
    v.object({ files: v.array(knownFile), continueCursor: v.string(), isDone: v.boolean() }),
  ),
  handler: (ctx, { lease: held, cursor }) =>
    withScanLease(ctx, "movies", held, async (scan) => {
      const found = await paginate(
        ctx.db,
        {
          table: "mediaFiles",
          index: "by_library_path",
          range: (q) => q.eq("libraryId", scan.library._id),
        },
        { numItems: KNOWN_PAGE, cursor },
      );

      return {
        value: {
          files: found.page
            .filter((file) => scan.keeps(file.path))
            .map(({ path, sizeBytes, mtimeMs, missing, sidecarDigest }) => ({
              path,
              sizeBytes,
              mtimeMs,
              missing,
              sidecarDigest,
            })),
          continueCursor: found.continueCursor,
          isDone: found.isDone,
        },
        added: 0,
        removed: 0,
      };
    }),
});

/**
 * Writes the leading files of up to 500 a scan found with their titles and episodes, in order, and queues scrub
 * thumbnails for new or changed files. A path sent twice in one batch is written twice, the last
 * one winning. Answers where each file landed, so the scanner can write credits for new titles.
 */
export const upsert = serverMutation({
  args: { lease, items: v.array(scannedItem) },
  returns: leaseAnswer(v.object({ files: v.array(upsertedFile), done: v.number() })),
  handler: (ctx, { lease: held, items }) =>
    withScanLease(ctx, "movies", held, async (scan) => {
      checkBatch(items.length);
      scan.admit(items.map((item) => item.file.path));

      const libraryId = scan.library._id;

      // A path over the filesystem's limit names no real file: it is skipped, and counts as done.
      const landed = await whileBudget(
        budgetFor(CALL_COST),
        items.map((item) => (pathFits(item.file.path) ? boundedItem(item) : null)),
        (item) => (item === null ? NO_WORK : upsertCost(ctx.db, libraryId, item)),
        async (item) => (item === null ? null : upsertScannedItem(ctx, libraryId, item)),
      );

      const written = landed.flatMap((one) => (one === null ? [] : [one]));
      const moved = sumMoved(written.map((one) => one.moved));

      await moveTotals(ctx.db, libraryId, moved);

      return {
        value: { files: written.map((one) => one.row), done: landed.length },
        added: moved.titles,
        removed: 0,
      };
    }),
});

/**
 * Marks the leading paths of up to 500 missing, as many as the call's budget admits, and answers
 * how many it got through (`done`) and how many were newly marked. Their titles, episodes, and
 * history stay. Repeating a path is harmless.
 */
export const missing = serverMutation({
  args: { lease, paths: v.array(v.string()) },
  returns: leaseAnswer(v.object({ marked: v.number(), done: v.number() })),
  handler: (ctx, { lease: held, paths }) =>
    withScanLease(ctx, "movies", held, async (scan) => {
      checkBatch(paths.length);

      const marked = await whileBudget(
        budgetFor(CALL_COST),
        scan.admit(paths),
        (path) => (pathFits(path) ? MISSING_COST : NO_WORK),
        async (path) => pathFits(path) && markFileMissing(ctx, scan.library._id, path),
      );

      return {
        value: { marked: marked.filter(Boolean).length, done: marked.length },
        added: 0,
        removed: 0,
      };
    }),
});
