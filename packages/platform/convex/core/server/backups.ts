import { register } from "../../../commands/core/server/backups";
import { enqueue } from "../jobs/queue";
import { paginate } from "../lib/paginate";

export const { list, run } = register({
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
  // A manual backup that joins a queued or running nightly one keeps the nightly trigger.
  run: async (ctx) => ({
    jobId: (await enqueue(ctx, { kind: "server.backup", trigger: "manual" })).jobId,
  }),
});
