import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { grantPrincipal, level } from "../../../commands/access";
import { callerScope, contentDomain } from "../../../commands/scopes";
import { internalMutation, internalQuery } from "../../_generated/server";
import { callerOfSession } from "../auth/caller";
import { grant, grantCreator, requireContent, revoke, visiblePage } from "./grants";
import { contentActions } from "./policy";

const SEED_MAX = 1000;

const probeFields = {
  name: v.string(),
  domain: contentDomain,
  age: v.union(v.number(), v.null()),
  explicit: v.boolean(),
};

const opened = v.object({ probeId: v.id("accessProbes"), name: v.string(), level });

/**
 * Makes probes managed by `managerId`, each with its first grant.
 *
 * @throws Error when asked for none or more than 1,000.
 */
export const seed = internalMutation({
  args: { managerId: v.id("users"), probes: v.array(v.object(probeFields)) },
  returns: v.array(v.id("accessProbes")),
  handler: async (ctx, { managerId, probes }) => {
    if (probes.length === 0 || probes.length > SEED_MAX) {
      throw new Error(`seed makes 1 to ${SEED_MAX} probes; got ${probes.length}`);
    }

    return Promise.all(
      probes.map(async (probe) => {
        const id = await ctx.db.insert("accessProbes", probe);

        await grantCreator(ctx, { type: "probe", id }, managerId);

        return id;
      }),
    );
  },
});

export const open = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    action: v.union(...contentActions.map((action) => v.literal(action))),
    probeId: v.id("accessProbes"),
  },
  returns: opened,
  handler: async (ctx, { sessionId, scope, action, probeId }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const visible = await requireContent(ctx, caller, action, { type: "probe", id: probeId });

    return { probeId: visible.doc._id, name: visible.doc.name, level: visible.level };
  },
});

export const list = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(opened),
  handler: async (ctx, { sessionId, scope, paginationOpts }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const page = await visiblePage(ctx, caller, "probe", paginationOpts);

    return {
      ...page,
      page: page.page.map((visible) => ({
        probeId: visible.doc._id,
        name: visible.doc.name,
        level: visible.level,
      })),
    };
  },
});

export const share = internalMutation({
  args: {
    sessionId: v.id("authSessions"),
    probeId: v.id("accessProbes"),
    principal: grantPrincipal,
    level,
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, probeId, principal, level: given }) => {
    const caller = await callerOfSession(ctx.db, sessionId, "signed-in");

    await grant(ctx, caller, { type: "probe", id: probeId }, principal, given);

    return null;
  },
});

export const unshare = internalMutation({
  args: {
    sessionId: v.id("authSessions"),
    probeId: v.id("accessProbes"),
    principal: grantPrincipal,
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, probeId, principal }) => {
    const caller = await callerOfSession(ctx.db, sessionId, "signed-in");

    await revoke(ctx, caller, { type: "probe", id: probeId }, principal);

    return null;
  },
});
