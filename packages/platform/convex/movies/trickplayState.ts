import type { Doc } from "../_generated/dataModel";
import { cancel, enqueue } from "../core/jobs/queue";
import type { JobCtx } from "../core/jobs/store";

const hasFrames = (file: Doc<"mediaFiles">): boolean =>
  !file.missing && file.probe.video.length > 0 && file.probe.durationMs > 0;

/** The contents of a file thumbnails are made from: its size and change time. */
export const contentRevision = (file: Doc<"mediaFiles">): string =>
  `${file.sizeBytes}:${file.mtimeMs}`;

const forCurrent = (file: Doc<"mediaFiles">): boolean =>
  file.trickplay !== undefined &&
  file.trickplay.sizeBytes === file.sizeBytes &&
  file.trickplay.mtimeMs === file.mtimeMs;

/**
 * What the file's last trickplay job came to: still `active`, `failed` for good, or `none` (gone,
 * canceled, or succeeded without a record). The job row is the record, so no reaction to a
 * finished job is needed (ADR 0012).
 */
const jobState = async (
  ctx: JobCtx,
  file: Doc<"mediaFiles">,
): Promise<"active" | "failed" | "none"> => {
  if (file.trickplay?.status !== "pending") return "none";

  const job = await ctx.db.get(file.trickplay.jobId);

  if (job === null) return "none";

  if (job.status === "queued" || (job.status === "running" && job.cancelRequestedAt === null)) {
    return "active";
  }

  return job.status === "failed" ? "failed" : "none";
};

/**
 * Queues a `movies.trickplay` job for `file` unless it has no frames, already has one queued or
 * running for its current contents, or has thumbnails of them. A job for older contents is
 * canceled and replaced, and the new job's dedupe key carries the new contents' revision, so it
 * never folds into a job for the old contents that is still running, whatever the file's state
 * recorded. A job that failed for the current contents counts as their failure, so a scan does
 * not queue it again; `retryFailed` queues it anyway, as an admin's request does.
 */
export const queueTrickplay = async (
  ctx: JobCtx,
  file: Doc<"mediaFiles">,
  retryFailed: boolean,
): Promise<void> => {
  if (!hasFrames(file)) return;

  const state = await jobState(ctx, file);
  const current = forCurrent(file);

  if (current && state === "active") return;

  const settled = current && file.trickplay?.status !== "pending" ? file.trickplay?.status : null;
  const failed = settled === "failed" || (current && state === "failed");

  if (settled === "ready" || (failed && !retryFailed)) return;

  if (state === "active" && file.trickplay?.status === "pending") {
    await cancel(ctx, file.trickplay.jobId);
  }

  const { jobId } = await enqueue(ctx, {
    kind: "movies.trickplay",
    fileId: file._id,
    revision: contentRevision(file),
  });

  await ctx.db.patch(file._id, {
    trickplay: { status: "pending", jobId, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs },
  });
};

/** The manifest players may use: thumbnails made from the file's contents now, or none. */
export const currentManifest = (file: Doc<"mediaFiles">) =>
  file.trickplay?.status === "ready" && forCurrent(file) ? file.trickplay.manifest : null;

/**
 * Forgets `file`'s thumbnails and cancels its job, as when the file goes missing or leaves the
 * library. The server's sweep deletes the sheets nobody records.
 */
export const forgetTrickplay = async (ctx: JobCtx, file: Doc<"mediaFiles">): Promise<void> => {
  if (file.trickplay?.status === "pending" && (await jobState(ctx, file)) === "active") {
    await cancel(ctx, file.trickplay.jobId);
  }

  if (file.trickplay !== undefined) await ctx.db.patch(file._id, { trickplay: undefined });
};
