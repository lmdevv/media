import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { fail } from "./lib/errors";

/**
 * Creates the account for a password sign-up. The first account becomes the admin; every later
 * one needs an open invite.
 */
export const createFromSignUp = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
  },
  handler: async (ctx, { email, name, inviteCode }) => {
    const anyUser = await ctx.db.query("users").first();

    if (anyUser === null) {
      return ctx.db.insert("users", { email, name: name ?? email.split("@")[0], role: "admin" });
    }

    if (inviteCode === undefined) {
      return fail("signup_closed", "Sign-up needs an invite from an admin");
    }

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", inviteCode))
      .unique();

    const now = Date.now();

    if (invite === null || invite.revoked || invite.acceptedBy !== undefined) {
      return fail("signup_closed", "This invite is not valid");
    }

    if (invite.expiresAt < now) return fail("signup_closed", "This invite has expired");

    if (invite.email !== undefined && invite.email !== email) {
      return fail("signup_closed", `This invite is for ${invite.email}`);
    }

    const userId = await ctx.db.insert("users", {
      email,
      name: name ?? email.split("@")[0],
      role: invite.role,
    });

    await ctx.db.patch(invite._id, { acceptedBy: userId, acceptedAt: now });

    return userId;
  },
});
