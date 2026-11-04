import { v } from "convex/values";

/** Grant levels, weakest first. Each level allows what the ones before it allow. */
export const levels = ["view", "edit", "manage"] as const;

interface ResourceTypeEntry {
  readonly table: string;
}

/**
 * Every resource type a grant can name, and the table that holds its rows. Only containers are
 * grantable: a library now, a playlist or a collection later. A title or a track has no grants of
 * its own; it is seen at its library's level.
 */
export const resourceTypes = {
  library: { table: "libraries" },
} as const satisfies Readonly<Record<string, ResourceTypeEntry>>;

const registered: ReadonlyArray<readonly [string, ResourceTypeEntry]> =
  Object.entries(resourceTypes);

/** A grant level as a Convex validator. */
export const level = v.union(...levels.map((name) => v.literal(name)));

/** A registered resource type's name as a Convex validator. */
export const resourceType = v.union(...registered.map(([type]) => v.literal(type)));

/** The id of a row of any registered resource type. */
export const resourceId = v.union(...registered.map(([, entry]) => v.id(entry.table)));

/** One grantable thing: its type, and the id of its row in that type's table. */
export const resourceRef = v.union(
  ...registered.map(([type, entry]) => v.object({ type: v.literal(type), id: v.id(entry.table) })),
);

/** A library's id, which the allowed-libraries restriction lists. */
export const libraryId = v.id("libraries");

/** Who a grant reaches: one user, a group's members, or every person on the server but guests. */
export const grantPrincipal = v.union(
  v.object({ kind: v.literal("user"), userId: v.id("users") }),
  v.object({ kind: v.literal("group"), groupId: v.id("groups") }),
  v.object({ kind: v.literal("household") }),
);

/** A kid's limits (ADR 0005). An admin sets them on a member; nobody sets their own. */
export const restrictions = v.object({
  /** The highest minimum viewer age a movie may carry, 0 to 21 (PG is 7); null means no cap. */
  maxMovieAge: v.union(v.number(), v.null()),
  hideUnrated: v.boolean(),
  hideExplicitMusic: v.boolean(),
  /** The libraries this person may use; null means every library their grants reach. */
  libraries: v.union(v.array(libraryId), v.null()),
});
