import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";

import { api, internal } from "../../_generated/api";
import type { DataModel } from "../../_generated/dataModel";
import { internalQuery } from "../../_generated/server";
import { fail } from "../lib/errors";
import { hashNewPassword } from "../lib/passwords";
import { requireUsername } from "../lib/usernames";
import type { SignedIn } from "../sessions";

type Params = Partial<Record<string, Value | undefined>>;

const setupParams = { username: v.string(), password: v.string() };

const inviteParams = { code: v.string(), username: v.string(), password: v.string() };

const resetParams = { code: v.string(), password: v.string() };

export const parseSetup = internalQuery({
  args: setupParams,
  returns: v.object(setupParams),
  handler: (_ctx, args) => args,
});

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

const parseSetupParams = makeFunctionReference<
  "query",
  Params,
  { readonly username: string; readonly password: string }
>("core/auth/flows:parseSetup");

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

export const setupProvider = ConvexCredentials<DataModel>({
  id: "setup",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { username, password } = await ctx.runQuery(parseSetupParams, params);

    requireUsername(username);

    if ((await ctx.runQuery(api.core.server.info, {})).hasOwner) {
      return fail("conflict", "This server already has an owner; sign in instead");
    }

    return ctx.runMutation(internal.core.accounts.users.setUp, {
      username,
      hash: await hashNewPassword(password),
    });
  },
});

export const inviteProvider = ConvexCredentials<DataModel>({
  id: "invite",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { code, username, password } = await ctx.runQuery(parseInviteParams, params);

    requireUsername(username);
    await ctx.runQuery(api.core.accounts.invites.lookup, { code });

    return ctx.runMutation(internal.core.accounts.invites.accept, {
      code,
      username,
      hash: await hashNewPassword(password),
    });
  },
});

export const resetProvider = ConvexCredentials<DataModel>({
  id: "reset",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { code, password } = await ctx.runQuery(parseResetParams, params);

    await ctx.runQuery(api.core.accounts.resetLinks.lookup, { code });

    return ctx.runMutation(internal.core.accounts.resetLinks.redeem, {
      code,
      hash: await hashNewPassword(password),
    });
  },
});
