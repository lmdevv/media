import { register } from "../../commands/core/together";
import { internal } from "../_generated/api";
import { asPerson } from "./accounts/users";
import { fail } from "./lib/errors";
import { takeAttempt } from "./lib/rateLimit";
import { constantTimeEqual, formatSecret, parseSecret, randomSecret } from "./lib/secrets";
import { mayPlay } from "./permissions/items";
import { can } from "./permissions/policy";
import { factsIn, factsOf, memberIn, placeOf, refuse, requireTogether } from "./together/access";
import { control as move } from "./together/clock";
import { admitMember, dropMember, enter, membersIn } from "./together/members";
import { BLOCKED_MAX, JOINS_PER_HOUR, LINK_PREFIX, LINK_SECRET_BYTES } from "./together/model";
import { heartbeat as beat } from "./together/presence";
import { enqueue, enqueueAll, queuePage, reorder as reorderEntry, unqueue } from "./together/queue";
import { endSession } from "./together/sessions";

const NO_LINK = "This link does not open a group session";

const NO_REQUEST = "No one by that name waits to join your group session";

export const {
  create,
  join,
  get,
  heartbeat,
  control,
  queue,
  add,
  addItems,
  remove,
  reorder,
  admit,
  block,
  configure,
  leave,
} = register({
  create: async (ctx, { item, join: joining, control: controls, add: adds }) => {
    const secret = randomSecret(LINK_SECRET_BYTES);

    const sessionId = await ctx.runMutation(internal.core.together.sessions.open, {
      item,
      secret,
      join: joining ?? "open",
      control: controls ?? false,
      add: adds ?? false,
    });

    return { sessionId, link: formatSecret(LINK_PREFIX, sessionId, secret) };
  },
  join: async (ctx, { domain, link }, caller) => {
    const now = Date.now();
    const parsed = parseSecret(LINK_PREFIX, link.trim()) ?? fail("not_found", NO_LINK);
    const sessionId = ctx.db.normalizeId("togetherSessions", parsed.rowId);
    const session = sessionId === null ? null : await ctx.db.get(sessionId);

    if (session === null || !constantTimeEqual(session.linkSecret, parsed.secret)) {
      return fail("not_found", NO_LINK);
    }

    if (session.item.domain !== domain) {
      return fail("invalid_args", `This link opens a ${session.item.domain} group session`);
    }

    const mine = await memberIn(ctx.db, caller.userId, domain);
    const place = placeOf(session, caller.userId, mine);
    const facts = factsOf(session, place);
    const joining = can(caller, "join", facts);
    const limit = { identifier: `together-join:${caller.userId}`, perHour: JOINS_PER_HOUR };

    if ((place === "outside" || place === "blocked") && !(await takeAttempt(ctx, limit, now))) {
      return fail("rate_limited", "You joined too many group sessions; wait a few minutes");
    }

    if (joining.allowed) return { state: await enter(ctx, session, caller.userId, "joined", now) };

    if (can(caller, "ask", facts).allowed) {
      return { state: await enter(ctx, session, caller.userId, "pending", now) };
    }

    return refuse(joining);
  },
  get: async (ctx, { domain }, caller) => {
    const member = await memberIn(ctx.db, caller.userId, domain);
    const session = member === null ? null : await ctx.db.get(member.sessionId);

    if (member === null || session === null) return null;

    const place = placeOf(session, caller.userId, member);
    const facts = factsOf(session, place);
    const seeing = can(caller, "see", facts);

    if (!seeing.allowed) return refuse(seeing);

    if (session.state === "ended") {
      return { state: "ended", sessionId: session._id, reason: session.reason };
    }

    const hostPerson = asPerson(await ctx.db.get(session.hostId));
    const host = hostPerson?.username ?? "";
    const hostDisplayName = hostPerson?.displayName ?? null;

    if (place === "pending") {
      return { state: "pending", sessionId: session._id, host, hostDisplayName };
    }

    const now = Date.now();

    const [joined, waiting] = await Promise.all([
      membersIn(ctx, session._id, "joined", now),
      place === "host" ? membersIn(ctx, session._id, "pending", now) : null,
    ]);

    const people = new Map(
      await Promise.all(
        [...joined, ...(waiting ?? [])].map(
          async (row) => [row.userId, asPerson(await ctx.db.get(row.userId))] as const,
        ),
      ),
    );

    return {
      state: "joined",
      sessionId: session._id,
      host,
      hostDisplayName,
      role: place === "host" ? "host" : "guest",
      link: formatSecret(LINK_PREFIX, session._id, session.linkSecret),
      settings: session.settings,
      may: {
        control: can(caller, "control", facts).allowed,
        add: can(caller, "add", facts).allowed,
        manage: can(caller, "manage", facts).allowed,
      },
      clock: session.clock,
      item: (await mayPlay(ctx.db, caller, session.item)) ? session.item : null,
      entryId: session.itemEntryId ?? null,
      members: joined.map((row) => ({
        userId: row.userId,
        username: people.get(row.userId)?.username ?? "",
        displayName: people.get(row.userId)?.displayName ?? null,
        role: row.userId === session.hostId ? "host" : "guest",
        present: row.awaySince === null,
        linkGuest: people.get(row.userId)?.role === "guest",
      })),
      pending:
        waiting === null
          ? null
          : waiting.map((row) => ({
              userId: row.userId,
              username: people.get(row.userId)?.username ?? "",
              displayName: people.get(row.userId)?.displayName ?? null,
              present: row.awaySince === null,
            })),
    };
  },
  heartbeat: (ctx, { domain }, caller) => beat(ctx, caller, domain),
  control: (ctx, { domain, op, sessionId }, caller) => move(ctx, caller, domain, op, sessionId),
  queue: (ctx, { domain, paginationOpts }, caller) =>
    queuePage(ctx, caller, domain, paginationOpts),
  add: async (ctx, { item, at, revision, sessionId }, caller) => ({
    entryId: await enqueue(ctx, caller, item, { at: at ?? "end", revision, sessionId }),
  }),
  addItems: async (ctx, { domain, sessionId, items }, caller) => ({
    taken: await enqueueAll(ctx, caller, domain, sessionId, items),
  }),
  remove: async (ctx, { domain, entryId }, caller) => {
    await unqueue(ctx, caller, domain, entryId);

    return null;
  },
  reorder: async (ctx, { domain, entryId, afterEntryId }, caller) => {
    await reorderEntry(ctx, caller, domain, entryId, afterEntryId);

    return null;
  },
  admit: async (ctx, { domain, userId }, caller) => {
    const { session } = await requireTogether(ctx, caller, domain, "admit");
    const row = await memberIn(ctx.db, userId, domain);

    if (row?.sessionId !== session._id) return fail("not_found", NO_REQUEST);

    await admitMember(ctx, row, Date.now());

    return null;
  },
  block: async (ctx, { domain, userId }) =>
    (await ctx.runMutation(internal.core.together.members.turnAway, { domain, userId }))
      ? null
      : fail(
          "conflict",
          `They are out, but this group session already turns away ${BLOCKED_MAX} people, as many as it can, so its link could let them back in; lock the session to keep everyone new out`,
        ),
  configure: async (ctx, { domain, join: joining, control: controls, add: adds }, caller) => {
    const { session } = await requireTogether(ctx, caller, domain, "manage");
    const { settings } = session;

    if (settings.join !== joining || settings.control !== controls || settings.add !== adds) {
      const changed = { join: joining, control: controls, add: adds };
      const cold = await factsIn(ctx.db, session._id);

      await ctx.db.patch(session._id, { settings: changed });

      if (cold !== null) await ctx.db.patch(cold._id, { settings: changed });
    }

    return null;
  },
  leave: async (ctx, { domain }, caller) => {
    const member = await memberIn(ctx.db, caller.userId, domain);

    if (member === null) return null;

    const { session, place } = await requireTogether(ctx, caller, domain, "leave");

    if (session.state === "live" && place === "host") {
      await endSession(ctx, session, "host-left");

      return null;
    }

    await dropMember(ctx, member);

    return null;
  },
});
