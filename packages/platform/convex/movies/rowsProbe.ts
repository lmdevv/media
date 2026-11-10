import { v } from "convex/values";

import { internalMutation } from "../_generated/server";

/** The most collections one call deletes. */
const DELETE_MAX = 500;

/**
 * The stack suite's way to delete collections and their memberships: between two pages of the
 * collections list, as an admin's cleanup or a purge might, to check the list's cursor neither
 * skips nor repeats one, and after a test, so no later suite pages through what it seeded. The
 * server never calls it.
 */
export const deleteCollections = internalMutation({
  args: { collectionIds: v.array(v.id("collections")) },
  returns: v.null(),
  handler: async (ctx, { collectionIds }) => {
    if (collectionIds.length > DELETE_MAX) {
      throw new Error(`delete at most ${DELETE_MAX} collections a call`);
    }

    await Promise.all(
      collectionIds.map(async (collectionId) => {
        const members = await ctx.db
          .query("collectionItems")
          .withIndex("by_collection_position", (q) => q.eq("collectionId", collectionId))
          .take(200);

        await Promise.all(members.map(async (member) => ctx.db.delete(member._id)));
        await ctx.db.delete(collectionId);
      }),
    );

    return null;
  },
});
