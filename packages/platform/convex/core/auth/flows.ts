import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";

import { api, internal } from "../../_generated/api";
import { internalQuery } from "../../_generated/server";
import { fail } from "../lib/errors";
import { hashNewPassword } from "../lib/passwords";
import { requireUsername } from "../lib/usernames";
import type { SignedIn } from "../sessions";
import { parseCredentials } from "./password";
import { behindBoundary } from "./passes";

type Params = Partial<Record<string, Value | undefined>>;

const inviteParams = { code: v.string(), username: v.string(), password: v.string() };

const resetParams = { code: v.string(), password: v.string() };

const guestParams = { code: v.string(), name: v.string() };

export const parseInvite = internalQuery({
  args: inviteParams,
  returns: v.object(inviteParams),
  handler: (_ctx, args) => args,
});

export const parseReset = internalQuery({
  args: resetParams,
  returns: v.object(resetParams),
  handler: (_ctx, args) => args,
});

/** Checks the `guest` provider's params' shape. */
export const parseGuest = internalQuery({
  args: guestParams,
  returns: v.object(guestParams),
  handler: (_ctx, args) => args,
});

const parseInviteParams = makeFunctionReference<
  "query",
  Params,
  { readonly code: string; readonly username: string; readonly password: string }
>("core/auth/flows:parseInvite");

const parseResetParams = makeFunctionReference<
  "query",
  Params,
  { readonly code: string; readonly password: string }
>("core/auth/flows:parseReset");

const parseGuestParams = makeFunctionReference<
  "query",
  Params,
  { readonly code: string; readonly name: string }
>("core/auth/flows:parseGuest");

export const setupProvider = behindBoundary({
  id: "setup",
  authorize: async (params, ctx, pass): Promise<SignedIn> => {
    const { username, password } = await ctx.runQuery(parseCredentials, params);

    requireUsername(username);

    if ((await ctx.runQuery(api.core.server.info, {})).hasOwner) {
      return fail("conflict", "This server already has an owner; sign in instead");
    }

    return ctx.runMutation(internal.core.accounts.users.setUp, {
      pass,
      username,
      hash: await hashNewPassword(password),
    });
  },
});

export const inviteProvider = behindBoundary({
  id: "invite",
  authorize: async (params, ctx, pass): Promise<SignedIn> => {
    const { code, username, password } = await ctx.runQuery(parseInviteParams, params);

    requireUsername(username);
    await ctx.runQuery(api.core.accounts.invites.lookup, { code });

    return ctx.runMutation(internal.core.accounts.invites.accept, {
      pass,
      code,
      username,
      hash: await hashNewPassword(password),
    });
  },
});

export const resetProvider = behindBoundary({
  id: "reset",
  authorize: async (params, ctx, pass): Promise<SignedIn> => {
    const { code, password } = await ctx.runQuery(parseResetParams, params);

    await ctx.runQuery(api.core.accounts.resetLinks.lookup, { code });

    return ctx.runMutation(internal.core.accounts.resetLinks.redeem, {
      pass,
      code,
      hash: await hashNewPassword(password),
    });
  },
});

/**
 * A guest opening a share link under the name they give (ADR 0007). Each open lets a new guest in;
 * the core opens the session, which ends no later than the link.
 */
export const guestProvider = behindBoundary({
  id: "guest",
  authorize: async (params, ctx, pass): Promise<SignedIn> => {
    const { code, name } = await ctx.runQuery(parseGuestParams, params);

    return ctx.runMutation(internal.core.guests.links.open, { pass, code, name });
  },
});
