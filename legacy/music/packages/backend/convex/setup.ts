import { v } from "convex/values";

import { query } from "./_generated/server";
import { sha256Hex } from "./lib/crypto";
import { inviterStillAllows } from "./lib/invites";
import { jamCodeOf, joinPolicy } from "./lib/jams";
import { readServerSettings } from "./lib/serverSettings";
import { resetByHash, resetStillAllowed } from "./lib/resets";

/** First-run state for the welcome screen. Public: it reveals only whether setup is done. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db.query("users").first();
    const library = await ctx.db.query("libraries").first();

    return { hasUsers: user !== null, hasLibraries: library !== null };
  },
});

/**
 * What the accept-invite screen shows for a code. Public, because the visitor is not signed in
 * yet; it reveals details only to someone who already holds the secret code.
 */
export const invite = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const found = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (found === null || found.revoked) return { state: "invalid" as const };
    const inviter = await ctx.db.get(found.createdBy);

    if (found.acceptedBy === undefined && !inviterStillAllows(inviter, found)) {
      return { state: "invalid" as const };
    }

    const details = {
      email: found.email ?? null,
      inviterName: inviter?.name ?? inviter?.email ?? null,
      createdAt: found._creationTime,
      expiresAt: found.expiresAt,
    };

    if (found.acceptedBy !== undefined) return { state: "used" as const, ...details };

    if (found.expiresAt < Date.now()) return { state: "expired" as const, ...details };

    return { state: "open" as const, ...details };
  },
});

/**
 * What a Jam link's landing page shows before someone joins: the host, what plays, how many are
 * in, and whether a visitor without an account may make a guest account. Public like `invite`:
 * only someone holding the secret link learns this.
 */
export const jam = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const found = await ctx.db
      .query("jams")
      .withIndex("by_code", (q) => q.eq("code", jamCodeOf(code)))
      .unique();

    if (found === null) return { state: "invalid" as const };

    if (found.status !== "active") return { state: "ended" as const };

    // Anyone holding the link sees this, signed in or not: whose Jam it is and how to get in,
    // nothing of what plays or who listens.
    const [host, settings] = await Promise.all([ctx.db.get(found.hostId), readServerSettings(ctx)]);

    // The policy in effect, so the page offers what will happen: after a removal an open Jam
    // asks the host, which anyone with the link can then tell.
    const policy = joinPolicy(found);

    return {
      state: policy,
      hostName: host?.name ?? "Someone",
      guestAccounts: settings.jamGuestAccounts && policy !== "locked",
    };
  },
});

/**
 * What the reset-password screen shows for a token. Public like `invite`: only someone holding
 * the secret token learns whose account it resets.
 */
export const passwordReset = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const hash = await sha256Hex(token);

    const found = await resetByHash(ctx, hash);

    const user = found === null ? null : await ctx.db.get(found.userId);

    if (found === null || user === null) return { state: "invalid" as const };

    const details = {
      email: user.email ?? "",
      name: user.name ?? null,
      expiresAt: found.expiresAt,
    };

    if (found.usedAt !== undefined) return { state: "used" as const, ...details };

    if (found.expiresAt < Date.now()) return { state: "expired" as const, ...details };

    // Redeeming refuses a suspended account, so its link shows as unusable rather than as a form
    // that can't succeed.
    if (user.suspendedAt !== undefined || !(await resetStillAllowed(ctx, found, user))) {
      return { state: "invalid" as const };
    }

    return { state: "open" as const, ...details };
  },
});
