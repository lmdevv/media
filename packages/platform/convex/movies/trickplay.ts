import { v } from "convex/values";

import { leaseAnswer, withJobLease } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import { fail } from "../core/lib/errors";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { contentRevision, currentManifest } from "./trickplayState";
import { nullable, trickplayManifest } from "./validators";

/** The most file ids one sweep call asks about. */
const SWEEP_MAX = 500;

/**
 * Records a file's finished scrub thumbnails during its trickplay job. Only the job the file now
 * waits on records, and only for the contents it was queued for: a result for contents the file
 * no longer has, or from a job a newer one replaced, changes nothing, since a job for the current
 * contents is queued. The server's sweep deletes thumbnails nobody records.
 */
export const recordTrickplay = serverMutation({
  args: {
    lease,
    fileId: v.id("mediaFiles"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    manifest: trickplayManifest,
  },
  returns: leaseAnswer(v.null()),
  handler: (ctx, { lease: held, fileId, sizeBytes, mtimeMs, manifest }) =>
    withJobLease(ctx, ["movies.trickplay"], held, async (job) => {
      if (job.payload.fileId !== fileId) fail("invalid_args", "This job is for another file");

      const file = await ctx.db.get(fileId);

      const current =
        file?.trickplay?.status === "pending" &&
        file.trickplay.jobId === job.jobId &&
        job.payload.revision === contentRevision(file) &&
        sizeBytes === file.sizeBytes &&
        mtimeMs === file.mtimeMs;

      if (current) {
        await ctx.db.patch(fileId, {
          trickplay: { status: "ready", sizeBytes, mtimeMs, manifest },
        });
      }

      return { outcome: "held", value: null };
    }),
});

/**
 * The thumbnail version each of up to 500 `fileIds` still uses, for the server's sweep of its
 * thumbnail folder: null for unknown ids, gone or missing files, and files without ready
 * thumbnails. The ids come from folder names, so they are checked rather than validated.
 */
export const trickplayVersions = serverQuery({
  args: { fileIds: v.array(v.string()) },
  returns: v.array(v.object({ fileId: v.string(), version: nullable(v.string()) })),
  handler: async (ctx, { fileIds }) => {
    if (fileIds.length > SWEEP_MAX) {
      fail("invalid_args", `Ask about at most ${SWEEP_MAX} files per call`);
    }

    return Promise.all(
      fileIds.map(async (fileId) => {
        const id = ctx.db.normalizeId("mediaFiles", fileId);
        const file = id === null ? null : await ctx.db.get(id);

        const version =
          file === null || file.missing ? null : (currentManifest(file)?.version ?? null);

        return { fileId, version };
      }),
    );
  },
});
