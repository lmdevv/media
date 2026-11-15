import type { PaginationOptions } from "convex/server";

import type { DomainItem } from "../../../commands/access";
import type { ContentDomain } from "../../../commands/scopes";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { asPerson } from "../accounts/users";
import { incrementCounter, readCounter } from "../lib/counters";
import { fail } from "../lib/errors";
import { paginateAtMost } from "../lib/paginate";
import { decidableRows, reachOf } from "../permissions/grants";
import { ITEM_READS, playableBy, requirePlayable } from "../permissions/items";
import { can } from "../permissions/policy";
import type { Principal } from "../permissions/policy";
import { factsOf, refuse, requireTogether } from "./access";
import type { InSession } from "./access";
import { QUEUE_MAX } from "./model";

/** The counter of a session's queued items. */
export const queueCounter = (sessionId: Id<"togetherSessions">): string =>
  `together-queue:${sessionId}`;

/** Where `add` puts an item: before everything queued, or after it. */
type Where = "next" | "end";

/**
 * Takes every queued copy of `item` out of `session`, each one only if the caller may remove it,
 * and answers how many went.
 */
const takeOutCopies = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  { session, place }: InSession,
  item: DomainItem,
): Promise<number> => {
  const copies = await ctx.db
    .query("togetherEntries")
    .withIndex("by_session_item", (q) =>
      q
        .eq("sessionId", session._id)
        .eq("item.ref.type", item.ref.type)
        .eq("item.ref.id", item.ref.id),
    )
    .take(QUEUE_MAX);

  for (const copy of copies) {
    const decision = can(
      caller,
      "remove",
      factsOf(session, place, { addedIt: copy.addedBy === caller.userId }),
    );

    if (!decision.allowed) refuse(decision);
  }

  await Promise.all(copies.map((copy) => ctx.db.delete(copy._id)));

  return copies.length;
};

/**
 * Queues `item` in the caller's session in its domain, which they must be able to play. `next`
 * puts it before everything queued and `end` after it, by an order one past the first or last.
 *
 * With `revision`, the item follows the one playing, as the next episode does: the add fails
 * `conflict` once the clock moved past `revision`, so a late one cannot queue it after the
 * session moved on, and any copy already queued is taken out first, so it is queued once.
 */
export const enqueue = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  item: DomainItem,
  at: Where,
  revision?: number,
): Promise<Id<"togetherEntries">> => {
  const inSession = await requireTogether(ctx, caller, item.domain, "add");
  const { session } = inSession;

  await requirePlayable(ctx.db, caller, item);

  if (revision !== undefined && revision !== session.clock.revision) {
    return fail("conflict", "The session moved on; apply its latest clock and try again");
  }

  const replaced = revision === undefined ? 0 : await takeOutCopies(ctx, caller, inSession, item);

  if ((await readCounter(ctx.db, queueCounter(session._id))) - replaced >= QUEUE_MAX) {
    return fail("conflict", `A group session queues at most ${QUEUE_MAX} items`);
  }

  if (replaced !== 1) await incrementCounter(ctx.db, queueCounter(session._id), 1 - replaced);

  const edge = await ctx.db
    .query("togetherEntries")
    .withIndex("by_session_order", (q) => q.eq("sessionId", session._id))
    .order(at === "next" ? "asc" : "desc")
    .first();

  const order = edge === null ? 0 : edge.order + (at === "next" ? -1 : 1);

  return ctx.db.insert("togetherEntries", {
    sessionId: session._id,
    order,
    item,
    addedBy: caller.userId,
  });
};

/**
 * Takes `entryId` out of the caller's session in `domain`: the host any entry, a guest who may add
 * only their own. An entry gone, or in another session, is no change, decided as if it were theirs.
 */
export const unqueue = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  entryId: Id<"togetherEntries">,
): Promise<void> => {
  const { session, place } = await requireTogether(ctx, caller, domain, "view");
  const found = await ctx.db.get(entryId);
  const entry = found?.sessionId === session._id ? found : null;
  const ownIt = entry === null || entry.addedBy === caller.userId;
  const decision = can(caller, "remove", factsOf(session, place, { addedIt: ownIt }));

  if (!decision.allowed) refuse(decision);

  if (entry === null) return;

  await ctx.db.delete(entry._id);
  await incrementCounter(ctx.db, queueCounter(session._id), -1);
};

const ENTRY_READS = ITEM_READS + 2;

/**
 * One page of what plays next in the caller's session in `domain`, as they may see it, of as many
 * entries as one call can decide.
 */
export const queuePage = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  options: PaginationOptions,
) => {
  const { session, place } = await requireTogether(ctx, caller, domain, "view");
  const reach = await reachOf(ctx.db, caller);
  const playable = playableBy(ctx.db, reach);

  const found = await paginateAtMost(
    ctx.db,
    {
      table: "togetherEntries",
      index: "by_session_order",
      range: (q) => q.eq("sessionId", session._id),
    },
    options,
    decidableRows(reach, ENTRY_READS),
  );

  const names = new Map<Id<"users">, Promise<string | null>>();

  const nameOf = (userId: Id<"users">): Promise<string | null> => {
    const name =
      names.get(userId) ?? ctx.db.get(userId).then((user) => asPerson(user)?.username ?? null);

    names.set(userId, name);

    return name;
  };

  const page = await Promise.all(
    found.page.map(async (entry) => ({
      entryId: entry._id,
      item: (await playable(entry.item)) ? entry.item : null,
      addedBy: await nameOf(entry.addedBy),
      removable: can(
        caller,
        "remove",
        factsOf(session, place, { addedIt: entry.addedBy === caller.userId }),
      ).allowed,
    })),
  );

  return { ...found, page };
};
