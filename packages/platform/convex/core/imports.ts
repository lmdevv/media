import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { ImportKind, PayloadOf } from "./jobs/kinds";
import { enqueue } from "./jobs/queue";
import type { JobCtx } from "./jobs/store";

interface Started {
  readonly importId: Id<"imports">;
  readonly jobId: Id<"jobs">;
  /** False when an import of this server was already queued or running; the ids are that one's. */
  readonly created: boolean;
}

/** The import row of a job, or null for a job no import started. */
export const importOfJob = (
  db: DatabaseReader,
  jobId: Id<"jobs">,
): Promise<Doc<"imports"> | null> =>
  db
    .query("imports")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique();

/**
 * Starts an import of one source server, or returns the active one. The kind's dedupe decides,
 * and the `imports` row is inserted only for a new job, in the caller's mutation, so the domain
 * inserts its plan row with the returned id in the same transaction.
 *
 * @throws Error when the active import job has no import row, which only `startImport` writes.
 */
export const startImport = async (
  ctx: JobCtx,
  payload: PayloadOf<ImportKind>,
  serverName: string,
): Promise<Started> => {
  const { jobId, created } = await enqueue(ctx, payload);

  if (created) {
    const importId = await ctx.db.insert("imports", {
      source: payload.source,
      serverId: payload.serverId,
      serverName,
      jobId,
    });

    return { importId, jobId, created };
  }

  const active = await importOfJob(ctx.db, jobId);

  if (active === null) throw new Error(`The active import job ${jobId} has no import row`);

  return { importId: active._id, jobId, created };
};
