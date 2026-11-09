import { v } from "convex/values";

import { leaseAnswer, withJobLease } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import { fail } from "../core/lib/errors";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { CREDIT_LIMIT, mergeIds, personKeyOf } from "./credits";
import { externalIds, scannedPersonDetails } from "./validators";

/** A person's name and external ids, for a person job to look up their details. */
export const personTarget = serverQuery({
  args: { personId: v.id("people") },
  returns: v.object({ personId: v.id("people"), name: v.string(), externalIds }),
  handler: async (ctx, { personId }) => {
    const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");

    return { personId, name: person.name, externalIds: person.externalIds };
  },
});

/**
 * Writes a person's details during their person job, or during a metadata job of a title that
 * credits them, which fetches its top-billed people itself.
 */
export const applyPerson = serverMutation({
  args: { lease, personId: v.id("people"), details: scannedPersonDetails },
  returns: leaseAnswer(v.null()),
  handler: (ctx, { lease: held, personId, details }) =>
    withJobLease(ctx, ["movies.person", "movies.metadata"], held, async (job) => {
      if (job.payload.kind === "movies.person" && job.payload.personId !== personId) {
        fail("invalid_args", "This job is for another person");
      }

      if (job.payload.kind === "movies.metadata") {
        const { titleId } = job.payload;

        const credited = await ctx.db
          .query("credits")
          .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", null))
          .take(CREDIT_LIMIT * 2);

        if (!credited.some((row) => row.personId === personId)) {
          fail("invalid_args", "This person is not credited on the job's title");
        }
      }

      const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");
      const ids = mergeIds(person.externalIds, details.externalIds);
      const now = Date.now();

      await ctx.db.patch(personId, {
        name: details.name,
        personKey: personKeyOf({ name: person.name, externalIds: ids }),
        externalIds: ids,
        profile: details.profile ?? person.profile,
        biography: details.biography,
        birthDate: details.birthDate,
        deathDate: details.deathDate,
        birthPlace: details.birthPlace,
        knownFor: details.knownFor,
        detailsFetchedAt: now,
        updatedAt: now,
      });

      return { outcome: "held", value: null };
    }),
});
