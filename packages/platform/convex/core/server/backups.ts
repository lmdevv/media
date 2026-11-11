import { register } from "../../../commands/core/server/backups";
import type { Doc } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { enqueue } from "../jobs/queue";
import { paginate } from "../lib/paginate";

const backupIn = (db: DatabaseReader, status: "queued" | "running"): Promise<Doc<"jobs"> | null> =>
  db
    .query("jobs")
    .withIndex("by_kind_status", (q) => q.eq("payload.kind", "server.backup").eq("status", status))
    .first();

export const { list, active, run } = register({
  list: async (ctx, { paginationOpts }) => {
    const page = await paginate(
      ctx.db,
      { table: "backups", index: "by_taken", order: "desc" },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.map((row) => ({
        id: row._id,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        trigger: row.trigger,
        takenAt: row.takenAt,
      })),
    };
  },
  // The running backup first, then a queued one; a canceled backup still running counts until its
  // worker stops, since it still holds the kind's one slot.
  active: async (ctx) => {
    const job = (await backupIn(ctx.db, "running")) ?? (await backupIn(ctx.db, "queued"));

    return job === null || (job.status !== "queued" && job.status !== "running")
      ? null
      : { jobId: job._id, status: job.status };
  },
  // A manual backup that joins a queued or running nightly one keeps the nightly trigger.
  run: async (ctx) => ({
    jobId: (await enqueue(ctx, { kind: "server.backup", trigger: "manual" })).jobId,
  }),
});
