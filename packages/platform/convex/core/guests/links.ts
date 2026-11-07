import { v } from "convex/values";

import { register } from "../../../commands/core/guests/links";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { asPerson } from "../accounts/users";
import { callerUser, refuseKeys, requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { PAGE_ROWS_MAX, paginate, paginateAtMost } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import { formatSecret, randomSecret, rowForSecret, sha256Hex } from "../lib/secrets";
import { LIST_CALL_READS, reachOf } from "../permissions/grants";
import { can, linkStanding, principalOf } from "../permissions/policy";
import type { Decision, Principal, ShareTargetFacts } from "../permissions/policy";
import { openSession, signedIn } from "../sessions";
import { factsOf, memberIn, placeOf, refuse } from "../together/access";
import { dropMember, enter } from "../together/members";
import { targetAs } from "./facts";
import {
  DAYS_MAX,
  DEFAULT_DAYS,
  GUESTS_PER_LINK_MAX,
  LINKS_PER_HOUR,
  LINK_PATH,
  LINK_PREFIX,
  LINK_SECRET_BYTES,
  OPENS_PER_LINK_PER_HOUR,
  guestAccessOf,
  guestKeyOf,
  requireGuestName,
  shareTarget,
  shownTarget,
} from "./model";
import type { GuestAccess, LinkDoc, ShareTarget, StoredTarget } from "./model";
import { newLinkStanding, standingOf } from "./standing";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Unknown, revoked, expired, and dead codes are refused alike, so a holder cannot tell which. */
const DEAD = "This link no longer works; ask whoever shared it for a new one";

const NO_LINK = "No such guest link";

const LIST_ROW_READS = 2;

const LIST_ROWS = Math.floor((PAGE_ROWS_MAX - LIST_CALL_READS) / LIST_ROW_READS);

const domainOf = (target: ShareTarget | StoredTarget) =>
  target.kind === "item" ? target.item.domain : target.domain;

const storedFor = async (
  db: DatabaseReader,
  caller: Caller,
  target: ShareTarget,
): Promise<StoredTarget | null> => {
  if (target.kind === "item") return target;

  const row = await memberIn(db, caller.userId, target.domain);

  return row === null ? null : { kind: "session", sessionId: row.sessionId, domain: target.domain };
};

const refuseMake = (
  decision: Extract<Decision, { readonly allowed: false }>,
  target: ShareTarget,
): never => {
  const { because, refusal } = decision;

  if (because === "switched-off") {
    return fail("forbidden", "Guest links are off; an admin can turn them on");
  }

  if (because === "not-allowed") {
    return fail("forbidden", "An admin has not let you share with guests");
  }

  if (because === "not-host" || because === "pending") {
    return fail("forbidden", "Only the host can share a group session");
  }

  if (because === "ended") return fail("expired", "This group session has ended");

  if (refusal === "hidden") {
    return fail(
      "not_found",
      target.kind === "item" ? "No such item" : "You host no group session in this domain",
    );
  }

  return fail("forbidden", "This session cannot share that with guests");
};

/**
 * `create`'s write, once its action made the secret. Checks the caller again with API keys
 * refused, decides `make` on what they ask to share, and stores the link with the stamps that
 * keep it dead once guest links go off or the caller loses the right to make it.
 */
export const insert = internalMutation({
  args: { secretHash: v.string(), target: shareTarget, expiresInDays: v.number() },
  returns: v.object({ linkId: v.id("shareLinks"), expiresAt: v.number(), address: v.string() }),
  handler: async (ctx, { secretHash, target, expiresInDays }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const now = Date.now();

    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > DAYS_MAX) {
      return fail("invalid_args", `A guest link lasts 1 to ${DAYS_MAX} days`);
    }

    const [access, maker, stored] = await Promise.all([
      guestAccessOf(ctx.db),
      callerUser(ctx, caller),
      storedFor(ctx.db, caller, target),
    ]);

    const facts: ShareTargetFacts =
      stored === null
        ? { kind: "session", session: { on: "together", domain: domainOf(target), session: null } }
        : await targetAs(ctx.db, await reachOf(ctx.db, caller), stored);

    const making = can(caller, "make", {
      ...newLinkStanding(access, caller, maker),
      about: { kind: "target", target: facts },
    });

    if (!making.allowed) return refuseMake(making, target);

    if (stored === null || access.address === null) return fail("not_found", NO_LINK);

    const limit = { identifier: `guest-links:${caller.userId}`, perHour: LINKS_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, now))) {
      return fail("rate_limited", "You made too many guest links; wait a few minutes");
    }

    const expiresAt = now + expiresInDays * DAY_MS;

    const linkId = await ctx.db.insert("shareLinks", {
      secretHash,
      maker: caller.userId,
      makerGeneration: maker.sessionGeneration,
      switchEpoch: access.epoch,
      target: stored,
      expiresAt,
      revokedAt: null,
    });

    return { linkId, expiresAt, address: access.address };
  },
});

const guestsOf = (db: DatabaseReader, linkId: Id<"shareLinks">): Promise<Array<Doc<"users">>> =>
  db
    .query("users")
    .withIndex("by_link", (q) => q.eq("link", linkId))
    .take(GUESTS_PER_LINK_MAX);

const seat = async (
  ctx: Pick<MutationCtx, "db">,
  guest: Principal,
  sessionId: Id<"togetherSessions">,
  now: number,
): Promise<void> => {
  const session = (await ctx.db.get(sessionId)) ?? fail("expired", DEAD);
  const facts = factsOf(session, placeOf(session, guest.userId, null), { invited: true });
  const joining = can(guest, "join", facts);

  if (joining.allowed) {
    await enter(ctx, session, guest.userId, "joined", now);

    return;
  }

  if (!can(guest, "ask", facts).allowed) return refuse(joining);

  await enter(ctx, session, guest.userId, "pending", now);
};

/**
 * The `guest` provider's write: lets a new guest in through a share link under the name they
 * gave, and opens their session. One transaction, so a refusal leaves no guest, seat, or spent
 * rate-limit token behind; only guests who get in count against the link.
 */
export const open = internalMutation({
  args: { code: v.string(), name: v.string() },
  returns: signedIn,
  handler: async (ctx, { code, name }) => {
    const now = Date.now();
    const username = requireGuestName(name);

    const link =
      (await rowForSecret(LINK_PREFIX, code, async (rowId) => {
        const id = ctx.db.normalizeId("shareLinks", rowId);

        return id === null ? null : ctx.db.get(id);
      })) ?? fail("expired", DEAD);

    const earlier = await guestsOf(ctx.db, link._id);

    const guestId = await ctx.db.insert("users", {
      kind: "person",
      role: "guest",
      username,
      usernameKey: guestKeyOf(link._id, earlier.length + 1),
      link: link._id,
      sessionGeneration: 0,
      keyGeneration: 0,
    });

    const guest = await ctx.db.get(guestId);

    if (guest?.kind !== "person" || guest.role !== "guest") return fail("expired", DEAD);

    const principal = principalOf(guest);
    const access = await guestAccessOf(ctx.db);

    const standing =
      standingOf(link, access, await ctx.db.get(link.maker), guest, now) ?? fail("expired", DEAD);

    const target = await targetAs(
      ctx.db,
      await reachOf(ctx.db, standing.maker.principal),
      link.target,
    );

    if (!can(principal, "open", { ...standing, about: { kind: "target", target } }).allowed) {
      return fail("expired", DEAD);
    }

    if (earlier.length >= GUESTS_PER_LINK_MAX) {
      return fail("conflict", "This link has let in as many guests as it can");
    }

    const limit = { identifier: `guest-open:${link._id}`, perHour: OPENS_PER_LINK_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, now))) {
      return fail("rate_limited", "This link was opened too often; wait a few minutes");
    }

    if (link.target.kind === "session") await seat(ctx, principal, link.target.sessionId, now);

    return {
      userId: guestId,
      sessionId: await openSession(ctx, guest, { kind: "guest", link }, now),
    };
  },
});

const unseat = async (
  ctx: Pick<MutationCtx, "db">,
  link: LinkDoc,
  target: Extract<StoredTarget, { readonly kind: "session" }>,
): Promise<void> => {
  const guests = await guestsOf(ctx.db, link._id);

  await Promise.all(
    guests.map(async (guest) => {
      const row = await memberIn(ctx.db, guest._id, target.domain);

      if (row?.sessionId === target.sessionId) await dropMember(ctx, row);
    }),
  );
};

const stateOf = (
  link: LinkDoc,
  access: GuestAccess,
  maker: Doc<"users"> | null,
  now: number,
): "open" | "revoked" | "expired" | "dead" => {
  const standing = standingOf(link, access, maker, null, now);

  if (standing === null) return "dead";

  if (standing.link !== "new" && standing.link.state !== "open") return standing.link.state;

  return linkStanding(standing).allowed ? "open" : "dead";
};

export const { create, list, activity, revoke } = register({
  create: async (ctx, { target, expiresInDays }) => {
    const secret = randomSecret(LINK_SECRET_BYTES);

    const made = await ctx.runMutation(internal.core.guests.links.insert, {
      secretHash: await sha256Hex(secret),
      target,
      expiresInDays: expiresInDays ?? DEFAULT_DAYS,
    });

    return {
      linkId: made.linkId,
      url: `${made.address}${LINK_PATH}${formatSecret(LINK_PREFIX, made.linkId, secret)}`,
      expiresAt: made.expiresAt,
    };
  },
  list: async (ctx, { whose, paginationOpts }, caller) => {
    const listing = can(caller, "audit", {
      on: "shareRecord",
      maker: whose === "mine" ? caller.userId : null,
    });

    if (!listing.allowed) return fail("forbidden", "Only an admin can list everyone's guest links");

    const page =
      whose === "mine"
        ? await paginateAtMost(
            ctx.db,
            {
              table: "shareLinks",
              index: "by_maker",
              range: (q) => q.eq("maker", caller.userId),
              order: "desc",
            },
            paginationOpts,
            LIST_ROWS,
          )
        : await paginateAtMost(
            ctx.db,
            { table: "shareLinks", index: "by_creation_time", order: "desc" },
            paginationOpts,
            LIST_ROWS,
          );

    const now = Date.now();
    const access = await guestAccessOf(ctx.db);

    const makers = new Map(
      await Promise.all(
        [...new Set(page.page.map((link) => link.maker))].map(
          async (makerId) => [makerId, await ctx.db.get(makerId)] as const,
        ),
      ),
    );

    return {
      ...page,
      page: page.page.map((link) => {
        const maker = makers.get(link.maker) ?? null;
        const seen = can(caller, "see", { on: "shareRecord", maker: link.maker }).allowed;

        return {
          linkId: link._id,
          madeBy: asPerson(maker)?.username ?? "",
          kind: link.target.kind,
          domain: domainOf(link.target),
          target: seen ? shownTarget(link.target) : null,
          state: stateOf(link, access, maker, now),
          madeAt: link._creationTime,
          expiresAt: link.expiresAt,
        };
      }),
    };
  },
  activity: async (ctx, { linkId, paginationOpts }, caller) => {
    const link = await ctx.db.get(linkId);

    if (link === null || !can(caller, "audit", { on: "shareRecord", maker: link.maker }).allowed) {
      return fail("not_found", NO_LINK);
    }

    const page = await paginate(
      ctx.db,
      { table: "users", index: "by_link", range: (q) => q.eq("link", linkId) },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.flatMap((user) =>
        user.kind === "person" && user.role === "guest"
          ? [{ guestId: user._id, name: user.username, openedAt: user._creationTime }]
          : [],
      ),
    };
  },
  revoke: async (ctx, { linkId }, caller) => {
    const link = await ctx.db.get(linkId);

    if (link === null || !can(caller, "revoke", { on: "shareRecord", maker: link.maker }).allowed) {
      return fail("not_found", NO_LINK);
    }

    if (link.revokedAt === null) await ctx.db.patch(link._id, { revokedAt: Date.now() });

    if (link.target.kind === "session") await unseat(ctx, link, link.target);

    return null;
  },
});
