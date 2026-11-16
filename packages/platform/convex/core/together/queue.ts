import type { PaginationOptions } from "convex/server";

import type { DomainItem } from "../../../commands/access";
import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import { asPerson } from "../accounts/users";
import { incrementCounter, readCounter } from "../lib/counters";
import { fail } from "../lib/errors";
import { paginateAtMost } from "../lib/paginate";
import { decidableRows, reachOf } from "../permissions/grants";
import { ITEM_READS, playableBy, requirePlayable } from "../permissions/items";
import { can } from "../permissions/policy";
import type { PersonDoc, Principal } from "../permissions/policy";
import { likedAmong, musicPresenter } from "../../music/present";
import { factsOf, refuse, requireQueue, requireTogether } from "./access";
import type { InSession, SessionDoc } from "./access";
import { QUEUE_MAX } from "./model";

/** The counter of a session's queued items. */
export const queueCounter = (sessionId: Id<"togetherSessions">): string =>
  `together-queue:${sessionId}`;

/** Where `add` puts an item: before everything queued, or after it. */
type Where = "next" | "end";

/** The entry queued first in `sessionId`, the one every gapless player preloads; null for none. */
export const firstQueued = (
  db: DatabaseReader,
  sessionId: Id<"togetherSessions">,
): Promise<Doc<"togetherEntries"> | null> =>
  db
    .query("togetherEntries")
    .withIndex("by_session_order", (q) => q.eq("sessionId", sessionId))
    .first();

/**
 * Keeps `queuedFirst` on `session` once a change to its queue is written: `firstId`, the entry
 * queued first now, since `now` when that is another entry than before. Every write to a session's
 * queue ends with it, in the same mutation, so a skip can tell the entry that was queued first by
 * the end of a song from one that got there later (ADR 0017).
 *
 * Each writer works `firstId` out from what it read before it wrote anything: a limited index read
 * in a Convex mutation after it wrote to that range can answer a row that moved where it stood, or
 * skip one, as after a delete and an insert.
 */
export const noteQueuedFirst = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  firstId: Id<"togetherEntries"> | null,
  now: number,
): Promise<void> => {
  if (firstId === (session.queuedFirst?.entryId ?? null)) return;

  await ctx.db.patch(session._id, {
    queuedFirst: firstId === null ? undefined : { entryId: firstId, since: now },
  });
};

/** The entry queued last in `sessionId`; null for none. */
const lastQueued = (
  db: DatabaseReader,
  sessionId: Id<"togetherSessions">,
): Promise<Doc<"togetherEntries"> | null> =>
  db
    .query("togetherEntries")
    .withIndex("by_session_order", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();

/**
 * Every queued copy of `item` in `session`, which an add with a revision takes out; it refuses the
 * add if the caller may not remove one of them.
 */
const copiesToTakeOut = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  { session, place }: InSession,
  item: DomainItem,
): Promise<ReadonlyArray<Doc<"togetherEntries">>> => {
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

  return copies;
};

/** The first of `entries`, in their order, that is not in `gone`; null for none. */
const firstLeft = (
  entries: ReadonlyArray<Doc<"togetherEntries">>,
  gone: ReadonlySet<Id<"togetherEntries">>,
): Doc<"togetherEntries"> | null => entries.find((entry) => !gone.has(entry._id)) ?? null;

/** How `enqueue` queues an item. */
export interface Placing {
  readonly at: Where;
  /** The clock the caller saw, for an item that follows the one playing; see `enqueue`. */
  readonly revision: number | undefined;
  /** The session the add was made for; see `requireTogether`. */
  readonly sessionId: Id<"togetherSessions"> | undefined;
}

/**
 * Queues `item` in the caller's session in its domain, which they must be able to play. `next`
 * puts it before everything queued and `end` after it, by an order one past the first or last.
 *
 * With `revision`, the item follows the one playing, as the next episode does: the add fails
 * `conflict` once the clock moved past `revision`, so a late one cannot queue it after the
 * session moved on, and any copy already queued is taken out first, so it is queued once. With
 * `sessionId`, it fails `conflict` once the caller is no longer in that session.
 */
export const enqueue = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  item: DomainItem,
  { at, revision, sessionId }: Placing,
): Promise<Id<"togetherEntries">> => {
  const inSession = await requireTogether(ctx, caller, item.domain, "add", sessionId);
  const { session } = inSession;

  await requirePlayable(ctx.db, caller, item);

  if (revision !== undefined && revision !== session.clock.revision) {
    return fail("conflict", "The session moved on; apply its latest clock and try again");
  }

  const copies = revision === undefined ? [] : await copiesToTakeOut(ctx, caller, inSession, item);
  const gone = new Set(copies.map((copy) => copy._id));
  const replaced = copies.length;

  if ((await readCounter(ctx.db, queueCounter(session._id))) - replaced >= QUEUE_MAX) {
    return fail("conflict", `A group session queues at most ${QUEUE_MAX} items`);
  }

  // Each end of the queue once the copies go, read before anything is written (`noteQueuedFirst`).
  const ends = (order: "asc" | "desc") =>
    ctx.db
      .query("togetherEntries")
      .withIndex("by_session_order", (q) => q.eq("sessionId", session._id))
      .order(order)
      .take(replaced + 1);

  const [first, last] = await Promise.all([ends("asc"), ends("desc")]);
  const head = firstLeft(first, gone);
  const edge = at === "next" ? head : firstLeft(last, gone);
  const order = edge === null ? 0 : edge.order + (at === "next" ? -1 : 1);

  await Promise.all(copies.map((copy) => ctx.db.delete(copy._id)));

  if (replaced !== 1) await incrementCounter(ctx.db, queueCounter(session._id), 1 - replaced);

  const entryId = await ctx.db.insert("togetherEntries", {
    sessionId: session._id,
    order,
    item,
    addedBy: caller.userId,
  });

  await noteQueuedFirst(ctx, session, at === "next" ? entryId : (head?._id ?? entryId), Date.now());

  return entryId;
};

/**
 * Queues `items` at the end of the caller's session in `domain`, the one `sessionId` names, in
 * order, as a host's player fills a new session with the songs they had queued after the first:
 * as many as one call can decide within `PAGE_ROWS_MAX` reads and the queue's room, leaving out
 * any the caller may not play, as a song deleted since. Answers how many of `items` it decided,
 * from the first, so the caller sends the rest again; 0 once the queue is full. Fails `conflict`
 * once the caller is no longer in that session (`requireTogether`), so a fill never lands in the
 * session that replaced it.
 */
export const enqueueAll = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  sessionId: Id<"togetherSessions">,
  items: ReadonlyArray<DomainItem>,
): Promise<number> => {
  if (items.length > QUEUE_MAX) {
    return fail("invalid_args", `A group session queues at most ${QUEUE_MAX} items`);
  }

  if (items.some((item) => item.domain !== domain)) {
    return fail("invalid_args", `Queue only ${domain} items in a ${domain} group session`);
  }

  const { session } = await requireTogether(ctx, caller, domain, "add", sessionId);
  const reach = await reachOf(ctx.db, caller);
  const playable = playableBy(ctx.db, reach);
  const room = QUEUE_MAX - (await readCounter(ctx.db, queueCounter(session._id)));
  const decided = items.slice(0, Math.max(0, Math.min(room, decidableRows(reach, ITEM_READS))));

  if (decided.length === 0) return 0;

  const kept = await Promise.all(
    decided.map(async (item) => ((await playable(item)) ? item : null)),
  );

  const queued = kept.filter((item) => item !== null);

  // Read before anything is written (`noteQueuedFirst`).
  const [head, last] = await Promise.all([
    firstQueued(ctx.db, session._id),
    lastQueued(ctx.db, session._id),
  ]);

  const from = last === null ? 0 : last.order + 1;

  const entryIds = await Promise.all(
    queued.map(async (item, at) =>
      ctx.db.insert("togetherEntries", {
        sessionId: session._id,
        order: from + at,
        item,
        addedBy: caller.userId,
      }),
    ),
  );

  if (queued.length > 0) await incrementCounter(ctx.db, queueCounter(session._id), queued.length);

  await noteQueuedFirst(ctx, session, head?._id ?? entryIds[0] ?? null, Date.now());

  return decided.length;
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

  // Read before anything is written (`noteQueuedFirst`).
  const head = await firstQueued(ctx.db, session._id);
  const first = head?._id === entry._id ? await firstAfter(ctx.db, session._id, entry.order) : head;

  await ctx.db.delete(entry._id);
  await incrementCounter(ctx.db, queueCounter(session._id), -1);
  await noteQueuedFirst(ctx, session, first?._id ?? null, Date.now());
};

/** The first entry of `sessionId` after `order`, or its first entry without one. */
export const firstAfter = (
  db: QueryCtx["db"],
  sessionId: Id<"togetherSessions">,
  order: number | null,
): Promise<Doc<"togetherEntries"> | null> =>
  db
    .query("togetherEntries")
    .withIndex("by_session_order", (q) =>
      order === null
        ? q.eq("sessionId", sessionId)
        : q.eq("sessionId", sessionId).gt("order", order),
    )
    .first();

/**
 * An order strictly between `lower` and `upper`, either of which may be absent, or null when no
 * number lies between them any more, as after many moves into one gap.
 */
const orderBetween = (lower: number | null, upper: number | null): number | null => {
  if (lower === null) return upper === null ? 0 : upper - 1;

  if (upper === null) return lower + 1;

  const middle = lower + (upper - lower) / 2;

  return middle > lower && middle < upper ? middle : null;
};

/**
 * Gives every entry of `sessionId` a whole-number order again, in play order, with `moved` right
 * after `anchor`, or first without one. A session queues at most `QUEUE_MAX` entries, so this
 * reads and writes at most that many.
 */
const renumber = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"togetherSessions">,
  moved: Doc<"togetherEntries">,
  anchor: Doc<"togetherEntries"> | null,
): Promise<void> => {
  const queued = await ctx.db
    .query("togetherEntries")
    .withIndex("by_session_order", (q) => q.eq("sessionId", sessionId))
    .take(QUEUE_MAX + 1);

  const rest = queued.filter((entry) => entry._id !== moved._id);
  const at = anchor === null ? 0 : rest.findIndex((entry) => entry._id === anchor._id) + 1;
  const ordered = [...rest.slice(0, at), moved, ...rest.slice(at)];

  await Promise.all(
    ordered.map(async (entry, order) => {
      if (entry.order !== order) await ctx.db.patch(entry._id, { order });
    }),
  );
};

/**
 * Moves `entryId` in the caller's session in `domain` to just after `afterEntryId`, or to the
 * front without one: the host any entry, a guest who may add only their own, as old music's jams
 * let people move the songs they added. An entry gone, or in another session, is no change,
 * decided as if it were theirs, as `unqueue` decides it. An anchor no longer queued fails
 * `conflict`, so the caller tries again against the queue as it now stands.
 */
export const reorder = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  entryId: Id<"togetherEntries">,
  afterEntryId: Id<"togetherEntries"> | undefined,
): Promise<void> => {
  const { session, place } = await requireTogether(ctx, caller, domain, "view");
  const found = await ctx.db.get(entryId);
  const entry = found?.sessionId === session._id ? found : null;
  const ownIt = entry === null || entry.addedBy === caller.userId;
  const decision = can(caller, "reorder", factsOf(session, place, { addedIt: ownIt }));

  if (!decision.allowed) refuse(decision);

  if (entry === null || afterEntryId === entry._id) return;

  const anchorRow = afterEntryId === undefined ? null : await ctx.db.get(afterEntryId);
  const anchor = anchorRow?.sessionId === session._id ? anchorRow : null;

  if (afterEntryId !== undefined && anchor === null) {
    return fail("conflict", "That entry is no longer queued; apply the latest queue and try again");
  }

  const following = await firstAfter(ctx.db, session._id, anchor?.order ?? null);

  // Already right after the anchor, or first: nothing moves.
  if (following?._id === entry._id) return;

  const order = orderBetween(anchor?.order ?? null, following?.order ?? null);

  // The entry queued first once this one moved, read before anything is written
  // (`noteQueuedFirst`): this one, moved to the front; the one after it, when it was first and
  // moved behind another; otherwise the same one as before.
  const head = await firstQueued(ctx.db, session._id);

  const first =
    anchor === null
      ? entry
      : head?._id === entry._id
        ? await firstAfter(ctx.db, session._id, entry.order)
        : head;

  if (order === null) await renumber(ctx, session._id, entry, anchor);
  else await ctx.db.patch(entry._id, { order });

  await noteQueuedFirst(ctx, session, first?._id ?? null, Date.now());
};

/** What a music song's details read on top of placing it: its document again, and its like. */
const SONG_READS = 3;

const ENTRY_READS = ITEM_READS + 2 + SONG_READS;

/** The music song `item` names, if it names one. */
const songOf = (item: DomainItem | null): Id<"tracks"> | null =>
  item?.ref.type === "track" ? item.ref.id : null;

/**
 * One page of what plays next in the caller's session in `domain`, as they may see it, of as many
 * entries as one call can decide, each music song with its details, as `music.queue.list` pages
 * carry theirs, so a client reads no song on its own; an entry they may not play has neither.
 *
 * It decides from the session's cold facts (`requireQueue`) and its entries, never its document, so
 * a page re-runs when its entries, the caller's likes, or the session's settings change, and not
 * on a pause, seek, or skip that leaves its entries as they are (ADR 0017).
 */
export const queuePage = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  options: PaginationOptions,
) => {
  const { sessionId, factsFor } = await requireQueue(ctx, caller, domain);
  const reach = await reachOf(ctx.db, caller);
  const playable = playableBy(ctx.db, reach);

  const found = await paginateAtMost(
    ctx.db,
    {
      table: "togetherEntries",
      index: "by_session_order",
      range: (q) => q.eq("sessionId", sessionId),
    },
    options,
    decidableRows(reach, ENTRY_READS),
  );

  const people = new Map<Id<"users">, Promise<PersonDoc | null>>();

  const personOf = (userId: Id<"users">): Promise<PersonDoc | null> => {
    const person = people.get(userId) ?? ctx.db.get(userId).then(asPerson);

    people.set(userId, person);

    return person;
  };

  const shown = await Promise.all(
    found.page.map(async (entry) => ({
      entry,
      item: (await playable(entry.item)) ? entry.item : null,
    })),
  );

  const songIds = [...new Set(shown.flatMap(({ item }) => songOf(item) ?? []))];

  const [songs, liked] = await Promise.all([
    Promise.all(songIds.map(async (trackId) => [trackId, await ctx.db.get(trackId)] as const)),
    likedAmong(ctx.db, caller.userId, songIds),
  ]);

  const songDocs = new Map(songs);
  const present = musicPresenter();

  const detailsOf = async (item: DomainItem | null) => {
    const trackId = songOf(item);
    const song = trackId === null ? null : (songDocs.get(trackId) ?? null);

    return song === null ? null : present.track(song, liked.has(song._id));
  };

  const page = await Promise.all(
    shown.map(async ({ entry, item }) => {
      // Who queued it, by username and the name they go by, or nulls for someone gone.
      const person = await personOf(entry.addedBy);

      return {
        entryId: entry._id,
        item,
        track: await detailsOf(item),
        addedBy: person?.username ?? null,
        addedByDisplayName: person?.displayName ?? null,
        removable: can(caller, "remove", factsFor({ addedIt: entry.addedBy === caller.userId }))
          .allowed,
      };
    }),
  );

  return { ...found, page };
};
