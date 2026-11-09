import type { Doc, Id } from "../_generated/dataModel";
import { enqueue } from "../core/jobs/queue";
import type { JobCtx } from "../core/jobs/store";

/** A match an admin chose for a title. */
export interface Match {
  readonly provider: "tmdb";
  readonly providerId: string;
}

/**
 * Asks for an admin's match of `title`: moves the title's match generation and queues the
 * metadata job that applies the match, carrying the new generation. Every write of that job is
 * then current, any refresh or earlier match asked for before it is stale and writes nothing, and
 * a later match supersedes this one (ADR 0012). The movies commands call this; nothing else moves
 * the generation.
 */
export const askForMatch = async (
  ctx: JobCtx,
  title: Doc<"titles">,
  match: Match,
): Promise<Id<"jobs">> => {
  const generation = title.matchGeneration + 1;

  await ctx.db.patch(title._id, { matchGeneration: generation });

  const queued = await enqueue(ctx, {
    kind: "movies.metadata",
    titleId: title._id,
    match: { provider: match.provider, providerId: match.providerId },
    revision: title.updatedAt,
    generation,
  });

  return queued.jobId;
};

/** Asks for a refresh of `title`'s metadata at its current match generation. */
export const askForRefresh = async (ctx: JobCtx, title: Doc<"titles">): Promise<Id<"jobs">> => {
  const queued = await enqueue(ctx, {
    kind: "movies.metadata",
    titleId: title._id,
    match: null,
    revision: title.updatedAt,
    generation: title.matchGeneration,
  });

  return queued.jobId;
};
