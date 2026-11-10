import { v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { leaseAnswer, withJobLease } from "./jobs/held";
import { lease } from "./jobs/model";
import { enqueue } from "./jobs/queue";
import { fail } from "./lib/errors";
import { paginate } from "./lib/paginate";
import { serverMutation, serverQuery } from "./lib/serverFacing";

/** Most archives one `sync` call takes, and the rows one call pages through. */
const SYNC_MAX = 500;

const FILE_NAME_CHARS_MAX = 255;

const CONTROL = /\p{Cc}/u;

const backupTrigger = v.union(v.literal("nightly"), v.literal("manual"));

/**
 * `typed` as a backup's file name: a plain name in the backup folder, 1 to 255 characters, with no
 * `/`, no control character, and not `.` or `..`. Refuses with `invalid_args`.
 */
const parseFileName = (typed: string): string =>
  typed.length === 0 ||
  typed.length > FILE_NAME_CHARS_MAX ||
  typed.includes("/") ||
  CONTROL.test(typed) ||
  typed === "." ||
  typed === ".."
    ? fail(
        "invalid_args",
        `A backup is a plain file name of 1 to ${FILE_NAME_CHARS_MAX} characters`,
      )
    : typed;

/** Refuses with `invalid_args` a size that is not a whole number of bytes, or a time that is not one. */
const checkArchive = (archive: { readonly sizeBytes: number; readonly takenAt: number }): void => {
  if (!Number.isSafeInteger(archive.sizeBytes) || archive.sizeBytes < 0) {
    fail("invalid_args", "A backup's size is a whole number of bytes");
  }

  if (!Number.isFinite(archive.takenAt) || archive.takenAt < 0) {
    fail("invalid_args", "A backup's time is a time since the epoch in milliseconds");
  }
};

const rowOfFile = (db: DatabaseReader, fileName: string): Promise<Doc<"backups"> | null> =>
  db
    .query("backups")
    .withIndex("by_file", (q) => q.eq("fileName", fileName))
    .first();

/**
 * Records the archive a `server.backup` job wrote, under its lease, with the job's trigger. A
 * retried call finds the row it wrote and answers it again.
 */
export const record = serverMutation({
  args: { lease, fileName: v.string(), sizeBytes: v.number(), takenAt: v.number() },
  returns: leaseAnswer(v.object({ backupId: v.id("backups") })),
  handler: (ctx, { lease: held, fileName, sizeBytes, takenAt }) => {
    const name = parseFileName(fileName);

    checkArchive({ sizeBytes, takenAt });

    return withJobLease(ctx, ["server.backup"], held, async (job) => {
      const found = await rowOfFile(ctx.db, name);

      const backupId: Id<"backups"> =
        found?._id ??
        (await ctx.db.insert("backups", {
          fileName: name,
          sizeBytes,
          trigger: job.payload.trigger,
          takenAt,
        }));

      return { outcome: "held", value: { backupId } };
    });
  },
});

/**
 * Makes the table list exactly the archives in the server's backup folder: rows without a file go
 * (retention pruned it), and files without a row are added (a restore brought back an older table,
 * or an admin copied an archive in). The server sends every archive, at most 500, on each call:
 * the first call (`cursor` null) adds the missing rows, and every call deletes the rows of one
 * page of at most 500 whose file is not sent. It calls again from `continueCursor` until `isDone`.
 * Safe to repeat.
 */
export const sync = serverMutation({
  args: {
    archives: v.array(
      v.object({
        fileName: v.string(),
        sizeBytes: v.number(),
        trigger: backupTrigger,
        takenAt: v.number(),
      }),
    ),
    cursor: v.union(v.string(), v.null()),
    /**
     * When the server began listing its folder. A row made after that, by a backup that finished
     * while the server listed, is kept even though the listing did not see its archive.
     */
    listedAt: v.number(),
  },
  returns: v.object({ continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { archives, cursor, listedAt }) => {
    if (archives.length > SYNC_MAX) {
      fail("invalid_args", `Send at most ${SYNC_MAX} archives`);
    }

    const onDisk = new Map(
      archives.map((archive) => {
        checkArchive(archive);

        return [parseFileName(archive.fileName), archive] as const;
      }),
    );

    if (cursor === null) {
      await Promise.all(
        [...onDisk].map(async ([fileName, archive]) => {
          if ((await rowOfFile(ctx.db, fileName)) !== null) return;

          await ctx.db.insert("backups", {
            fileName,
            sizeBytes: archive.sizeBytes,
            trigger: archive.trigger,
            takenAt: archive.takenAt,
          });
        }),
      );
    }

    const page = await paginate(
      ctx.db,
      { table: "backups", index: "by_taken" },
      { numItems: SYNC_MAX, cursor },
    );

    await Promise.all(
      page.page.flatMap((row) =>
        onDisk.has(row.fileName) || row._creationTime >= listedAt ? [] : [ctx.db.delete(row._id)],
      ),
    );

    return { continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** The archive of a backup, for a restore; null for an id that names none. */
export const file = serverQuery({
  args: { backupId: v.string() },
  returns: v.union(v.null(), v.object({ fileName: v.string() })),
  handler: async (ctx, { backupId }) => {
    const id = ctx.db.normalizeId("backups", backupId);
    const row = id === null ? null : await ctx.db.get(id);

    return row === null ? null : { fileName: row.fileName };
  },
});

/** The nightly cron's backup; it joins a backup already queued or running. */
export const nightly = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await enqueue(ctx, { kind: "server.backup", trigger: "nightly" });

    return null;
  },
});
