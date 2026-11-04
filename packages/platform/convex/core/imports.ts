import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { importSource } from "./jobs/kinds";
import type { JobKind, PayloadOf } from "./jobs/kinds";
import { enqueue } from "./jobs/queue";
import { paginate } from "./lib/paginate";

type ImportSource = Infer<typeof importSource>;

type ImportKind = {
  [Kind in JobKind]: PayloadOf<Kind> extends {
    readonly kind: Kind;
    readonly source: ImportSource;
    readonly serverId: string;
  }
    ? Kind
    : never;
}[JobKind];

interface SourceServer {
  readonly source: ImportSource;
  readonly serverId: string;
  readonly serverName: string;
}

interface Started {
  readonly importId: Id<"imports">;
  readonly jobId: Id<"jobs">;
  /** False when an import of this server was already queued or running; the ids are that one's. */
  readonly created: boolean;
}

const importOfJob = (db: DatabaseReader, jobId: Id<"jobs">): Promise<Doc<"imports"> | null> =>
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
  ctx: MutationCtx,
  kind: ImportKind,
  server: SourceServer,
): Promise<Started> => {
  const { jobId, created } = await enqueue(ctx, {
    kind,
    source: server.source,
    serverId: server.serverId,
  });

  if (created) {
    const importId = await ctx.db.insert("imports", { ...server, jobId });

    return { importId, jobId, created };
  }

  const active = await importOfJob(ctx.db, jobId);

  if (active === null) throw new Error(`The active import job ${jobId} has no import row`);

  return { importId: active._id, jobId, created };
};

const importView = v.object({
  id: v.id("imports"),
  source: importSource,
  serverId: v.string(),
  serverName: v.string(),
  jobId: v.id("jobs"),
  createdAt: v.number(),
});

export const listByServer = internalQuery({
  args: { source: importSource, serverId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(importView),
  handler: async (ctx, { source, serverId, paginationOpts }) => {
    const result = await paginate(
      ctx.db,
      {
        table: "imports",
        index: "by_source_server",
        range: (q) => q.eq("source", source).eq("serverId", serverId),
        order: "desc",
      },
      paginationOpts,
    );

    return {
      ...result,
      page: result.page.map((row) => ({
        id: row._id,
        source: row.source,
        serverId: row.serverId,
        serverName: row.serverName,
        jobId: row.jobId,
        createdAt: row._creationTime,
      })),
    };
  },
});

export const probeStart = internalMutation({
  args: { source: importSource, serverId: v.string(), serverName: v.string() },
  returns: v.object({ importId: v.id("imports"), jobId: v.id("jobs"), created: v.boolean() }),
  handler: (ctx, server) => startImport(ctx, "probe.import", server),
});
