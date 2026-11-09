import { v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { leaseAnswer, withJobLease } from "../core/jobs/held";
import type { HeldJob } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import type { Lease } from "../core/jobs/model";
import type { JobCtx } from "../core/jobs/store";
import { fail } from "../core/lib/errors";
import { inOrder } from "../core/lib/inOrder";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { rescannedTitle, rewriteTitle, upsertEpisode } from "./catalog";
import { CREDIT_LIMIT, creditsOf, replaceCredits } from "./credits";
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

/** The most episodes a target lists: more than any show the scanner has met. */
const TARGET_EPISODES_MAX = 4000;

const UNDATED_COLLECTION_POSITION = 9999;

const titleOf = async (ctx: JobCtx, titleId: Id<"titles">): Promise<Doc<"titles">> =>
  (await ctx.db.get(titleId)) ?? fail("not_found", "No such title");

/**
 * What a metadata job needs to look a title up: its name and year with overrides applied, its
 * external ids, artwork, and episode numbers.
 */
export const metadataTarget = serverQuery({
  args: { titleId: v.id("titles") },
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
  }),
  handler: async (ctx, { titleId }) => {
    const title = (await ctx.db.get(titleId)) ?? fail("not_found", "No such title");

    const episodes = await ctx.db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .take(TARGET_EPISODES_MAX);

    return {
      titleId,
      libraryId: title.libraryId,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      externalIds: title.externalIds,
      artwork: title.artwork,
      episodes: episodes.map((episode) => ({
        episodeId: episode._id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })),
    };
  },
});

/**
 * Writes fetched metadata during the title's metadata job, and up to 500 of a show's episodes. A
 * job carrying an admin's match marks the title manual, so later scans keep its metadata.
 */
export const applyMetadata = serverMutation({
  args: {
    lease,
    titleId: v.id("titles"),
    title: scannedTitle,
    episodes: v.array(scannedEpisode),
  },
  returns: leaseAnswer(v.null()),
  handler: (ctx, { lease: held, titleId, title, episodes }) =>
    withJobLease(ctx, ["movies.metadata"], held, async (job) => {
      if (job.payload.titleId !== titleId) fail("invalid_args", "This job is for another title");

      if (episodes.length > EPISODES_MAX) {
        fail("invalid_args", `Send at most ${EPISODES_MAX} episodes per call`);
      }

      const current = await titleOf(ctx, titleId);
      const fields = rescannedTitle(title, current);

      await rewriteTitle(ctx.db, current, {
        ...fields,
        kind: current.kind,
        matchStatus:
          job.payload.match !== null || current.matchStatus === "manual"
            ? "manual"
            : fields.matchStatus,
      });

      const landed =
        current.kind === "show"
          ? await inOrder(episodes, (episode) => upsertEpisode(ctx.db, titleId, episode))
          : [];

      await moveTotals(ctx.db, current.libraryId, sumMoved(landed.map((one) => one.moved)));

      return { outcome: "held", value: null };
    }),
});

type MetadataLease = HeldJob<"movies.metadata" | "movies.scan">;

/**
 * Whether the held job may write the title's credits or collection: a metadata job for exactly
 * this title, or a scan of its library while no admin matched it by hand.
 *
 * @throws ConvexError `invalid_args` for a job of another title or library.
 */
const mayWrite = (job: MetadataLease, title: Doc<"titles">): boolean => {
  if (job.payload.kind === "movies.metadata") {
    return (
      job.payload.titleId === title._id || fail("invalid_args", "This job is for another title")
    );
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

      const title = await titleOf(ctx, titleId);
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
      const title = await titleOf(ctx, titleId);

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
