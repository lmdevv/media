import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { fail } from "./lib/errors";
import { inviterStillAllows } from "./lib/invites";
import {
  GUESTS_PER_HOUR,
  GUESTS_PER_JAM_PER_HOUR,
  MAX_GUESTS_PER_JAM,
  jamCodeOf,
  joinPolicy,
} from "./lib/jams";
import { takeAttempt } from "./lib/rateLimit";
import { readServerSettings } from "./lib/serverSettings";
import { openSession } from "./lib/sessions";
import { roleOf } from "./lib/viewer";
import type { ReadCtx } from "./lib/viewer";

const TOO_MANY = "Too many people joined as guests just now. Try again in a few minutes.";

/**
 * Makes a guest account from a Jam link, within the limits above, and puts it in the Jam: let in
 * at once when the Jam is open, or waiting for the host when it asks for approval.
 */
const createJamGuest = async (
  ctx: MutationCtx,
  jam: Doc<"jams">,
  email: string,
  name: string | undefined,
): Promise<Id<"users">> => {
  const guests = await ctx.db
    .query("users")
    .withIndex("by_jam_guest", (q) => q.eq("joinedViaJam", jam._id))
    .take(MAX_GUESTS_PER_JAM);

  if (guests.length >= MAX_GUESTS_PER_JAM) {
    return fail("signup_closed", "This Jam has as many guests as it can take. Ask for an invite.");
  }

  // Server-wide first: one busy Jam must not use up the others' share.
  if (!(await takeAttempt(ctx, "jam-guests", GUESTS_PER_HOUR))) {
    return fail("rate_limited", TOO_MANY);
  }

  if (!(await takeAttempt(ctx, `jam-guests:${jam._id}`, GUESTS_PER_JAM_PER_HOUR))) {
    return fail("rate_limited", TOO_MANY);
  }

  const userId = await ctx.db.insert("users", {
    email,
    name,
    role: "guest",
    joinedViaJam: jam._id,
  });

  await ctx.db.insert("jamMembers", {
    jamId: jam._id,
    userId,
    status: joinPolicy(jam) === "approval" ? "pending" : "joined",
    listening: false,
    updatedAt: Date.now(),
  });

  return userId;
};

/**
 * What lets a sign-up in: being the first account, an open invite for this email, or, where an
 * admin allows it, the link of an active Jam that lets people in (a guest account).
 */
type SignUpPass =
  | { readonly kind: "first" }
  | { readonly kind: "invite"; readonly invite: Doc<"invites"> }
  | { readonly kind: "jam"; readonly jam: Doc<"jams"> };

/**
 * A Jam link as a pass: only while an admin lets Jam links make guest accounts, and only for an
 * active Jam that is letting people in.
 */
const jamPass = async (ctx: ReadCtx, code: string): Promise<SignUpPass> => {
  if (!(await readServerSettings(ctx)).jamGuestAccounts) {
    return fail("signup_closed", "This server doesn't make accounts from Jam links");
  }

  const jam = await ctx.db
    .query("jams")
    .withIndex("by_code", (q) => q.eq("code", jamCodeOf(code)))
    .unique();

  if (jam === null || jam.status !== "active" || joinPolicy(jam) === "locked") {
    return fail("signup_closed", "This Jam link doesn't work any more");
  }

  // Only members and admins may hand out a link that makes accounts. Their Jam ends when they stop
  // being one; this holds meanwhile, and for any Jam that slipped past.
  const host = await ctx.db.get(jam.hostId);

  if (host === null || host.suspendedAt !== undefined || roleOf(host) === "guest") {
    return fail("signup_closed", "This Jam link doesn't work any more");
  }

  return { kind: "jam", jam };
};

/**
 * Checks that `email` may sign up, or fails with `signup_closed` saying why. The first account
 * needs nothing; every later one needs an open invite that its sender may still give, or a Jam
 * link as above.
 */
const signUpPass = async (
  ctx: ReadCtx,
  email: string,
  inviteCode: string | undefined,
  jamCode: string | undefined,
): Promise<SignUpPass> => {
  if ((await ctx.db.query("users").first()) === null) return { kind: "first" };

  if (inviteCode === undefined && jamCode !== undefined) return jamPass(ctx, jamCode);

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

/**
 * Adds the person a sign-up lets in, using up their invite. The first account is the owner; a Jam
 * link makes a guest who hears nothing but that Jam.
 */
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

  if (pass.kind === "jam") return createJamGuest(ctx, pass.jam, email, displayName);

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
    jamCode: v.optional(v.string()),
    provider: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, { email, name, inviteCode, jamCode, provider, secret }) => {
    const pass = await signUpPass(ctx, email, inviteCode, jamCode);

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
    jamCode: v.optional(v.string()),
  },
  handler: async (ctx, { email, name, inviteCode, jamCode }) =>
    insertSignedUp(ctx, await signUpPass(ctx, email, inviteCode, jamCode), email, name),
});
