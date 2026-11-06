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
import { QUEUE_MAX } from "./model";

/** The counter of a session's queued items. */
export const queueCounter = (sessionId: Id<"togetherSessions">): string =>
  `together-queue:${sessionId}`;

/** Where `add` puts an item: before everything queued, or after it. */
type Where = "next" | "end";

/**
 * Queues `item` in the caller's session in its domain, which they must be able to play. `next`
 * puts it before everything queued and `end` after it, by an order one past the first or last.
 */
export const enqueue = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  item: DomainItem,
  at: Where,
): Promise<Id<"togetherEntries">> => {
  const { session } = await requireTogether(ctx, caller, item.domain, "add");

  await requirePlayable(ctx.db, caller, item);

  if ((await readCounter(ctx.db, queueCounter(session._id))) >= QUEUE_MAX) {
    return fail("conflict", `A group session queues at most ${QUEUE_MAX} items`);
  }

  await incrementCounter(ctx.db, queueCounter(session._id), 1);

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
  const decision = can(caller, "remove", factsOf(session, place, ownIt));

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
      removable: can(caller, "remove", factsOf(session, place, entry.addedBy === caller.userId))
        .allowed,
    })),
  );

  return { ...found, page };
};
