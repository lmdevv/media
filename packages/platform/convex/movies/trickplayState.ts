import type { Doc } from "../_generated/dataModel";
import type { PayloadOf } from "../core/jobs/kinds";
import { cancel, enqueue } from "../core/jobs/queue";
import type { JobCtx } from "../core/jobs/store";
import { patchMediaFile, replaceMediaFile } from "./write";

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

  await patchMediaFile(ctx.db, file, {
    trickplay: { status: "pending", jobId, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs },
  });
};

/** The manifest players may use: thumbnails made from the file's contents now, or none. */
export const currentManifest = (file: Doc<"mediaFiles">) =>
  file.trickplay?.status === "ready" && forCurrent(file) ? file.trickplay.manifest : null;

/**
 * Forgets `file`'s thumbnails and cancels its job, as when the file goes missing or leaves the
 * library, and answers the file as stored. The server's sweep deletes the sheets nobody records.
 */
export const forgetTrickplay = async (
  ctx: JobCtx,
  file: Doc<"mediaFiles">,
): Promise<Doc<"mediaFiles">> => {
  if (file.trickplay?.status === "pending" && (await jobState(ctx, file)) === "active") {
    await cancel(ctx, file.trickplay.jobId);
  }

  const { _id: _fileId, _creationTime: _created, trickplay, ...kept } = file;

  return trickplay === undefined ? file : replaceMediaFile(ctx.db, file, kept);
};

/**
 * Releases a file from its finished trickplay job as the job is deleted, so no file waits on a job
 * that is gone. A failed job is the failure of the contents it was for, which `queueTrickplay`
 * keeps from queuing again, so the file records that failure itself; after a canceled or succeeded
 * job the file is as if no job had been queued, which is what a gone job meant already.
 */
export const releaseTrickplayJob = async (
  ctx: JobCtx,
  job: Pick<Doc<"jobs">, "_id" | "status"> & { readonly payload: PayloadOf<"movies.trickplay"> },
): Promise<void> => {
  const file = await ctx.db.get(job.payload.fileId);
  const waiting = file?.trickplay;

  if (file === null || waiting?.status !== "pending" || waiting.jobId !== job._id) return;

  if (job.status === "failed") {
    await patchMediaFile(ctx.db, file, {
      trickplay: { status: "failed", sizeBytes: waiting.sizeBytes, mtimeMs: waiting.mtimeMs },
    });

    return;
  }

  const { _id: _fileId, _creationTime: _created, trickplay: _released, ...kept } = file;

  await replaceMediaFile(ctx.db, file, kept);
};
