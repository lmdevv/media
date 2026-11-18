import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { collectionsOf, plus, queryOf } from "./reads";
import type { Reads } from "./reads";

/** A title's memberships read to choose its collection: a title is in a few at most. */
const MEMBERSHIPS_READ = 20;

/** What {@link collectionOf} reads at most: a title's memberships and the collection it picks. */
export const COLLECTION_OF: Reads = plus(queryOf(MEMBERSHIPS_READ), collectionsOf(1));

/**
 * The collection a title's page shows: the one its metadata names, else the first it is in, or
 * null. `movies.titles.get` and `movies.collections.ofTitle` both choose through it, so they
 * name the same collection.
 */
export const collectionOf = async (
  db: DatabaseReader,
  titleId: Id<"titles">,
): Promise<Doc<"collections"> | null> => {
  const memberships = await db
    .query("collectionItems")
    .withIndex("by_title", (q) => q.eq("titleId", titleId))
    .take(MEMBERSHIPS_READ);

  const membership = memberships.find((member) => member.source === "metadata") ?? memberships[0];

  return membership === undefined ? null : db.get(membership.collectionId);
};
