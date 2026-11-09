import { v } from "convex/values";

import { leaseAnswer } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import { inOrder } from "../core/lib/inOrder";
import { paginate } from "../core/lib/paginate";
import { serverMutation } from "../core/lib/serverFacing";
import { withScanLease } from "../core/scans";
import { checkTitle, markFileMissing, upsertScannedItem } from "./catalog";
import { moveTotals, sumMoved } from "./totals";
import { knownFile, scannedItem, upsertedFile } from "./validators";

/**
 * The most files one `upsert` takes, sized from the worst case, not the average (ADR 0013).
 *
 * - Writes: one file writes at most 55 documents. That is a title rewritten with all 20 of its
 *   genre rows replaced (1 + 2 × 20), a season, an episode, and the season's count (3), the file
 *   (1), the present-file counts of its old and new title and episode (4), and a scrub-thumbnail
 *   job canceled and queued with the file's state (6). So 80 files write at most 4,400 of 16,000.
 * - Index ranges read, the tighter bound: every `get`, query, patch, and delete reads one, and
 *   Convex fails a call past 4,096. The worst file is one whose show is rewritten with every
 *   genre replaced, whose episode moves, and whose thumbnails are queued again. On the dev stack
 *   100 such files committed and 110 failed with "Too many reads", so 80 keeps a fifth in
 *   reserve. Old movies wrote 100 a call, with genres unbounded.
 */
const UPSERT_MAX = 80;

/** The most paths one `missing` takes: each writes at most 7 documents (ADR 0024). */
const PATHS_MAX = 500;

const KNOWN_PAGE = 1000;

const checkBatch = (count: number, most: number): void => {
  if (count > most) throw new Error(`A batch holds at most ${most} files; got ${count}`);
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
 * Writes up to 80 files a scan found with their titles and episodes, in order, and queues scrub
 * thumbnails for new or changed files. A path sent twice in one batch is written twice, the last
 * one winning. Answers where each file landed, so the scanner can write credits for new titles.
 */
export const upsert = serverMutation({
  args: { lease, items: v.array(scannedItem) },
  returns: leaseAnswer(v.object({ files: v.array(upsertedFile) })),
  handler: (ctx, { lease: held, items }) =>
    withScanLease(ctx, "movies", held, async (scan) => {
      checkBatch(items.length, UPSERT_MAX);
      scan.admit(items.map((item) => item.file.path));
      items.forEach((item) => checkTitle(item.title));

      const landed = await inOrder(items, (item) => upsertScannedItem(ctx, scan.library._id, item));

      const moved = sumMoved(landed.map((one) => one.moved));

      await moveTotals(ctx.db, scan.library._id, moved);

      return {
        value: { files: landed.map((one) => one.row) },
        added: moved.titles,
        removed: 0,
      };
    }),
});

/**
 * Marks up to 500 of the library's files missing by path; their titles, episodes, and history
 * stay. Answers how many were newly marked, so repeating a path is harmless.
 */
export const missing = serverMutation({
  args: { lease, paths: v.array(v.string()) },
  returns: leaseAnswer(v.object({ marked: v.number() })),
  handler: (ctx, { lease: held, paths }) =>
    withScanLease(ctx, "movies", held, async (scan) => {
      checkBatch(paths.length, PATHS_MAX);

      const marked = await inOrder([...new Set(scan.admit(paths))], (path) =>
        markFileMissing(ctx, scan.library._id, path),
      );

      return {
        value: { marked: marked.filter(Boolean).length },
        added: 0,
        removed: 0,
      };
    }),
});
