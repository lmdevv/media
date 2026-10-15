import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { fail } from "./lib/errors";
import { inviterStillAllows } from "./lib/invites";
import { openSession } from "./lib/sessions";
import type { ReadCtx } from "./lib/viewer";

/** What lets a sign-up in: being the first account, or an open invite for this email. */
type SignUpPass =
  | { readonly kind: "first" }
  | { readonly kind: "invite"; readonly invite: Doc<"invites"> };

/**
 * Checks that `email` may sign up, or fails with `signup_closed` saying why. The first account
 * needs nothing; every later one needs an open invite that its sender may still give.
 */
const signUpPass = async (
  ctx: ReadCtx,
  email: string,
  inviteCode: string | undefined,
): Promise<SignUpPass> => {
  if ((await ctx.db.query("users").first()) === null) return { kind: "first" };

  if (inviteCode === undefined)
    return fail("signup_closed", "Sign-up needs an invite from an admin");

  const invite = await ctx.db
    .query("invites")
    .withIndex("by_code", (q) => q.eq("code", inviteCode))
    .unique();

  if (invite === null || invite.revoked || invite.acceptedBy !== undefined) {
    return fail("signup_closed", "This invite is not valid");
  }

  if (invite.expiresAt < Date.now()) return fail("signup_closed", "This invite has expired");

  if (!inviterStillAllows(await ctx.db.get(invite.createdBy), invite)) {
    return fail("signup_closed", "This invite is no longer valid; ask an admin for a new one");
  }

  if (invite.email !== undefined && invite.email !== email) {
    return fail("signup_closed", `This invite is for ${invite.email}`);
  }

  return { kind: "invite", invite };
};

/** Adds the person a sign-up lets in, using up their invite. The first account is the owner. */
const insertSignedUp = async (
  ctx: MutationCtx,
  pass: SignUpPass,
  email: string,
  name: string | undefined,
): Promise<Id<"users">> => {
  const displayName = name ?? email.split("@")[0];

  if (pass.kind === "first") {
    return ctx.db.insert("users", { email, name: displayName, role: "owner" });
  }

  const userId = await ctx.db.insert("users", { email, name: displayName, role: pass.invite.role });

  await ctx.db.patch(pass.invite._id, { acceptedBy: userId, acceptedAt: Date.now() });

  return userId;
};

/**
 * Creates the person and the password account for a sign-up, in one transaction: fails with
 * `signup_closed` unless the email may sign up, and only then returns null when a password
 * account already uses it. Sign-up has no rate limit, so without a valid invite every email gets
 * the same answer, and nobody learns which have accounts. `secret` is the password's hash.
 */
/**
 * The account ID to sign in with, for an email as typed and as sign-up cleans it: the typed one
 * when an account has it (one made before the cleaning), otherwise the cleaned one (where sign-up
 * keeps new accounts). Both lead to the same check and the same answer, so this tells nothing.
 */
export const signInAccountId = internalQuery({
  args: { provider: v.string(), typed: v.string(), cleaned: v.string() },
  handler: async (ctx, { provider, typed, cleaned }) => {
    if (typed === cleaned) return typed;

    const legacy = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", provider).eq("providerAccountId", typed),
      )
      .unique();

    return legacy === null ? cleaned : typed;
  },
});

export const createPasswordAccount = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
    provider: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, { email, name, inviteCode, provider, secret }) => {
    const pass = await signUpPass(ctx, email, inviteCode);

    const existing = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", provider).eq("providerAccountId", email),
      )
      .unique();

    if (existing !== null) return null;

    const userId = await insertSignedUp(ctx, pass, email, name);

    await ctx.db.insert("authAccounts", { userId, provider, providerAccountId: email, secret });

    return userId;
  },
});

/**
 * Opens the session for a password sign-in whose check (`retrieveAccount`) passed, in one
 * transaction with a second look at the account: if its password changed since the check (a
 * reset landed in between), or the person was suspended, no session opens. A session opened
 * before such a change records the generation it was opened in, which the change ends
 * (`endUserSessions`), so no sign-in that checked the old password outlives a reset.
 */
export const openPasswordSession = internalMutation({
  args: { accountId: v.id("authAccounts"), secret: v.string() },
  handler: async (ctx, { accountId, secret }) => {
    const account = await ctx.db.get(accountId);

    if (account?.secret !== secret) return { kind: "changed" } as const;
    const user = await ctx.db.get(account.userId);

    if (user === null) return { kind: "changed" } as const;

    if (user.suspendedAt !== undefined) return { kind: "suspended" } as const;

    return { kind: "open", userId: user._id, sessionId: await openSession(ctx, user) } as const;
  },
});

/**
 * Creates the person for an account Convex Auth makes itself. Password sign-up makes its own
 * (`createPasswordAccount`), so this only guards the callback: the same rules apply.
 */
export const createFromSignUp = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
  },
  handler: async (ctx, { email, name, inviteCode }) =>
    insertSignedUp(ctx, await signUpPass(ctx, email, inviteCode), email, name),
});
