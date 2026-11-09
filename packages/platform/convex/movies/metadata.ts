import { v } from "convex/values";

import { register } from "../../commands/movies/metadata";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { leaseAnswer, withJobLease } from "../core/jobs/held";
import type { HeldJob } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import type { Lease } from "../core/jobs/model";
import type { JobCtx } from "../core/jobs/store";
import { fail } from "../core/lib/errors";
import { paginate } from "../core/lib/paginate";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { budgetFor, whileBudget, work } from "./budget";
import { requireTitle } from "./access";
import {
  EPISODE_COST,
  rescannedTitle,
  rewriteCost,
  rewriteTitle,
  upsertEpisode,
  writeOverrides,
} from "./catalog";
import { CREDIT_LIMIT, creditsOf, replaceCredits } from "./credits";
import { askForMatch, askForRefresh } from "./matching";
import { moveTotals, sumMoved } from "./totals";
import {
  artwork,
  externalIds,
  nullable,
  scannedCollection,
  scannedCredit,
  scannedEpisode,
  scannedTitle,
  titleKind,
} from "./validators";

/** The most episodes one metadata call writes, and one target lists. */
const EPISODES_MAX = 500;

/** A metadata call's own work: the lease check, the title, and the episode total. */
const CALL_COST = work(12, 4);

/** Episodes one target page lists; the worker follows `continueCursor` to the end. */
const TARGET_PAGE = 1000;

const UNDATED_COLLECTION_POSITION = 9999;

/** A title, or `not_found` when it is gone or the purge is deleting it. */
const titleOf = async (db: DatabaseReader, titleId: Id<"titles">): Promise<Doc<"titles">> => {
  const title = await db.get(titleId);

  return title === null || title.purging === true ? fail("not_found", "No such title") : title;
};

/**
 * What a metadata job needs to look a title up: its name and year with overrides applied, its
 * external ids, artwork, and a page of up to 1,000 of its episodes' numbers from `cursor`, in
 * season and episode order. The worker asks again with `continueCursor` until `isDone`, so a show
 * of any length is listed whole.
 */
export const metadataTarget = serverQuery({
  args: { titleId: v.id("titles"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    titleId: v.id("titles"),
    libraryId: v.id("libraries"),
    kind: titleKind,
    name: v.string(),
    year: nullable(v.number()),
    externalIds,
    artwork,
    episodes: v.array(
      v.object({
        episodeId: v.id("episodes"),
        seasonNumber: v.number(),
        episodeNumber: v.number(),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { titleId, cursor }) => {
    const title = await titleOf(ctx.db, titleId);

    const episodes = await paginate(
      ctx.db,
      {
        table: "episodes",
        index: "by_title_order",
        range: (q) => q.eq("titleId", titleId),
      },
      { numItems: TARGET_PAGE, cursor },
    );

    return {
      titleId,
      libraryId: title.libraryId,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      externalIds: title.externalIds,
      artwork: title.artwork,
      episodes: episodes.page.map((episode) => ({
        episodeId: episode._id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })),
      continueCursor: episodes.continueCursor,
      isDone: episodes.isDone,
    };
  },
});

/**
 * Whether a metadata job is still the title's current one: no admin's match was asked for since
 * it was (`askForMatch` moves the generation when a match is asked for, never when one applies).
 * A stale job's writes are dropped whole (ADR 0012).
 */
const current = (asked: { readonly generation: number }, title: Doc<"titles">): boolean =>
  asked.generation === title.matchGeneration;

/**
 * Writes fetched metadata during the title's metadata job, and the leading episodes of up to 500
 * of a show's as the call's budget admits, answering how many it wrote (`done`); the worker sends
 * the rest again, and the title, already written, costs nothing more. A job carrying an admin's
 * match marks the title manual, so later scans keep its metadata. A job asked for before a newer
 * match writes nothing and answers `applied: false` with `done: 0`: the worker stops that job
 * rather than sending the rest again.
 */
export const applyMetadata = serverMutation({
  args: {
    lease,
    titleId: v.id("titles"),
    title: scannedTitle,
    episodes: v.array(scannedEpisode),
  },
  returns: leaseAnswer(v.object({ done: v.number(), applied: v.boolean() })),
  handler: (ctx, { lease: held, titleId, title, episodes }) =>
    withJobLease(ctx, ["movies.metadata"], held, async (job) => {
      if (job.payload.titleId !== titleId) fail("invalid_args", "This job is for another title");

      if (episodes.length > EPISODES_MAX) {
        fail("invalid_args", `Send at most ${EPISODES_MAX} episodes per call`);
      }

      const stored = await titleOf(ctx.db, titleId);

      if (!current(job.payload, stored)) {
        return { outcome: "held", value: { done: 0, applied: false } };
      }

      const fields = rescannedTitle(title, stored);
      const manual = job.payload.match !== null;
      const budget = budgetFor(CALL_COST);

      budget.spend(rewriteCost(stored, title));

      await rewriteTitle(ctx.db, stored, {
        ...fields,
        kind: stored.kind,
        matchStatus: manual || stored.matchStatus === "manual" ? "manual" : fields.matchStatus,
      });

      const landed =
        stored.kind === "show"
          ? await whileBudget(
              budget,
              episodes,
              () => EPISODE_COST,
              (episode) => upsertEpisode(ctx.db, titleId, episode),
            )
          : [];

      await moveTotals(ctx.db, stored.libraryId, sumMoved(landed.map((one) => one.moved)));

      return {
        outcome: "held",
        value: { done: stored.kind === "show" ? landed.length : episodes.length, applied: true },
      };
    }),
});

type MetadataLease = HeldJob<"movies.metadata" | "movies.scan">;

/**
 * Whether the held job may write the title's credits or collection: a metadata job for exactly
 * this title whose match generation is still the title's, or a scan of its library while no admin
 * matched it by hand.
 *
 * @throws ConvexError `invalid_args` for a job of another title or library.
 */
const mayWrite = (job: MetadataLease, title: Doc<"titles">): boolean => {
  if (job.payload.kind === "movies.metadata") {
    if (job.payload.titleId !== title._id) fail("invalid_args", "This job is for another title");

    return current(job.payload, title);
  }

  if (job.payload.libraryId !== title.libraryId) {
    fail("invalid_args", "This scan is of another library");
  }

  return title.matchStatus !== "manual";
};

const withMetadataLease = <Value>(
  ctx: JobCtx,
  held: Lease,
  write: (job: MetadataLease) => Promise<Value>,
) =>
  withJobLease(ctx, ["movies.metadata", "movies.scan"], held, async (job) => ({
    outcome: "held" as const,
    value: await write(job),
  }));

const creditedPerson = (person: Doc<"people">) => ({
  personId: person._id,
  tmdbId: person.externalIds.tmdb,
  needsDetails: person.detailsFetchedAt === null && person.externalIds.tmdb !== null,
});

const creditsAnswer = v.object({
  written: v.boolean(),
  people: v.array(
    v.object({
      personId: v.id("people"),
      tmdbId: nullable(v.string()),
      needsDetails: v.boolean(),
    }),
  ),
});

/**
 * Replaces the cast and crew of a title or one of its episodes during the title's metadata job or
 * a scan of its library, unless `hash` matches what is stored or, during a scan, an admin matched
 * the title by hand. A metadata refresh without a new match keeps credits a scan wrote. Answers
 * the people credited and whether each still needs a person job for their details.
 */
export const applyCredits = serverMutation({
  args: {
    lease,
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    credits: v.array(scannedCredit),
    hash: v.string(),
  },
  returns: leaseAnswer(creditsAnswer),
  handler: (ctx, { lease: held, titleId, episodeId, credits, hash }) =>
    withMetadataLease(ctx, held, async (job) => {
      if (credits.length > CREDIT_LIMIT) {
        fail("invalid_args", `Send at most ${CREDIT_LIMIT} credits per call`);
      }

      const title = await titleOf(ctx.db, titleId);
      const episode = episodeId === null ? null : await ctx.db.get(episodeId);

      if (episodeId !== null && episode?.titleId !== titleId) {
        fail("not_found", "No such episode of this title");
      }

      const stored = episode === null ? title.creditsHash : episode.creditsHash;

      if (stored === hash || !mayWrite(job, title)) return { written: false, people: [] };

      if (
        job.payload.kind === "movies.metadata" &&
        job.payload.match === null &&
        stored !== undefined
      ) {
        const rows = await creditsOf(ctx.db, titleId, episodeId, CREDIT_LIMIT);
        const people = await Promise.all(rows.map((row) => ctx.db.get(row.personId)));

        return {
          written: false,
          people: people.flatMap((person) => (person === null ? [] : [creditedPerson(person)])),
        };
      }

      const people = await replaceCredits(ctx.db, titleId, episodeId, credits);

      if (episode === null) await ctx.db.patch(titleId, { creditsHash: hash });
      else await ctx.db.patch(episode._id, { creditsHash: hash });

      return { written: true, people: people.map(creditedPerson) };
    }),
});

const positionOf = (title: Doc<"titles">): number =>
  title.overrides?.year ?? title.year ?? UNDATED_COLLECTION_POSITION;

const collectionFor = async (
  ctx: JobCtx,
  collection: { readonly sourceKey: string; readonly name: string },
): Promise<Doc<"collections"> | null> => {
  const bySource = await ctx.db
    .query("collections")
    .withIndex("by_source_key", (q) => q.eq("sourceKey", collection.sourceKey))
    .first();

  if (bySource !== null) return bySource;

  const namesakes = await ctx.db
    .query("collections")
    .withIndex("by_sort", (q) => q.eq("sortKey", collection.name.trim().toLowerCase()))
    .take(10);

  return (
    namesakes.find((candidate) => !(candidate.sourceKey?.startsWith("tmdb:") ?? false)) ?? null
  );
};

/**
 * Puts a title in the collection its metadata names, creating the collection on first sight, and
 * takes it out of any other collection its metadata put it in. A collection of the same name that
 * an import created is reused, so a TMDB collection and a Jellyfin box set become one. Runs under
 * the title's metadata job or a scan of its library, as `applyCredits` does.
 */
export const applyCollection = serverMutation({
  args: {
    lease,
    titleId: v.id("titles"),
    collection: nullable(scannedCollection),
    hash: v.string(),
  },
  returns: leaseAnswer(v.null()),
  handler: (ctx, { lease: held, titleId, collection, hash }) =>
    withMetadataLease(ctx, held, async (job) => {
      const title = await titleOf(ctx.db, titleId);

      if (title.collectionHash === hash || !mayWrite(job, title)) return null;

      await ctx.db.patch(titleId, { collectionHash: hash });

      const now = Date.now();
      const target = collection === null ? null : await collectionFor(ctx, collection);

      if (collection !== null && target !== null) {
        await ctx.db.patch(target._id, {
          overview: collection.overview ?? target.overview,
          poster: collection.poster ?? target.poster,
          backdrop: collection.backdrop ?? target.backdrop,
          updatedAt: now,
        });
      }

      const collectionId =
        collection === null
          ? null
          : (target?._id ??
            (await ctx.db.insert("collections", {
              name: collection.name.trim(),
              sortKey: collection.name.trim().toLowerCase(),
              sourceKey: collection.sourceKey,
              createdAt: now,
              updatedAt: now,
              overview: collection.overview,
              poster: collection.poster,
              backdrop: collection.backdrop,
            })));

      const memberships = await ctx.db
        .query("collectionItems")
        .withIndex("by_title", (q) => q.eq("titleId", titleId))
        .take(CREDIT_LIMIT);

      await Promise.all(
        memberships.flatMap((member) =>
          member.source === "metadata" && member.collectionId !== collectionId
            ? [ctx.db.delete(member._id)]
            : [],
        ),
      );

      const member = memberships.find((entry) => entry.collectionId === collectionId);

      if (member !== undefined && member.source !== "metadata") {
        await ctx.db.patch(member._id, { source: "metadata" });
      }

      if (collectionId !== null && member === undefined) {
        await ctx.db.insert("collectionItems", {
          collectionId,
          titleId,
          position: positionOf(title),
          source: "metadata",
        });
      }

      return null;
    }),
});

/** The oldest minimum viewer age a rating may ask for (ADR 0005). */
const AGE_RATING_MAX = 21;

type Overrides = NonNullable<Doc<"titles">["overrides"]>;

const OVERRIDE_BOUNDS: ReadonlyArray<{
  readonly broken: (overrides: Overrides) => boolean;
  readonly message: string;
}> = [
  {
    broken: ({ name }) => name !== undefined && name.trim() === "",
    message: "Names are not blank",
  },
  {
    broken: ({ sortName }) => sortName !== undefined && sortName.trim() === "",
    message: "Sort names are not blank",
  },
  {
    broken: ({ year }) => year !== undefined && !Number.isInteger(year),
    message: "Years are whole numbers",
  },
  {
    broken: ({ ageRating }) =>
      ageRating !== undefined &&
      (!Number.isInteger(ageRating) || ageRating < 0 || ageRating > AGE_RATING_MAX),
    message: `Age ratings run from 0 to ${AGE_RATING_MAX}`,
  },
];

const checkedOverrides = (overrides: Overrides): Overrides => {
  const broken = OVERRIDE_BOUNDS.find((bound) => bound.broken(overrides));

  return broken === undefined ? overrides : fail("invalid_args", broken.message);
};

/**
 * The metadata commands. Each needs `movies:edit` and an `edit` grant on the title's library,
 * which `requireTitle` decides through `can()`. A match or a refresh goes through
 * `askForMatch` and `askForRefresh`, so the match generation fences every metadata job.
 */
export const { match, refresh, edit } = register({
  match: async (ctx, { titleId, provider, providerId }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "edit", titleId);
    const chosen = providerId.trim();

    if (chosen.length === 0) return fail("invalid_args", "Choose a match");

    return { jobId: await askForMatch(ctx, title, { provider, providerId: chosen }) };
  },
  refresh: async (ctx, { titleId }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "edit", titleId);

    return { jobId: await askForRefresh(ctx, title) };
  },
  edit: async (ctx, { titleId, set, clear }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "edit", titleId);
    const merged: Overrides = { ...title.overrides, ...checkedOverrides(set) };

    for (const field of clear ?? []) delete merged[field];

    await writeOverrides(ctx.db, title, merged);

    return null;
  },
});
