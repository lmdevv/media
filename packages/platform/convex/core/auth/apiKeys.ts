import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";

import { register } from "../../../commands/core/auth/apiKeys";
import { credentialScope } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { DataModel } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import { fail } from "../lib/errors";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { endKeySessions, endUserKeys, keyWorks, openSession } from "../sessions";
import type { SignedIn } from "../sessions";
import { refuseKeys, requireCaller } from "./caller";

const PREFIX = "mk";

const DAY_MS = 24 * 60 * 60 * 1000;

const NAME_MAX = 64;

const EXPIRY_DAYS_MAX = 365;

const BAD_KEY = "This API key does not work";

const keyParams = { key: v.string() };

const parseKeyParams = makeFunctionReference<
  "query",
  Partial<Record<string, Value | undefined>>,
  { readonly key: string }
>("core/auth/apiKeys:parse");

/** Checks the sign-in params' shape. */
export const parse = internalQuery({
  args: keyParams,
  returns: v.object(keyParams),
  handler: (_ctx, args) => args,
});

/** The API key provider. Every refusal is one `unauthenticated` message. */
export const apiKeyProvider = ConvexCredentials<DataModel>({
  id: "apiKey",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { key } = await ctx.runQuery(parseKeyParams, params);
    const parsed = parseSecret(PREFIX, key);

    if (parsed === null) return fail("unauthenticated", BAD_KEY);

    const opened: SignedIn | null = await ctx.runMutation(internal.core.auth.apiKeys.redeem, {
      keyId: parsed.rowId,
      secretHash: await sha256Hex(parsed.secret),
    });

    return opened ?? fail("unauthenticated", BAD_KEY);
  },
});

/** Signs in with a key into a new session of its own. Null when the key fails. */
export const redeem = internalMutation({
  args: { keyId: v.string(), secretHash: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { keyId, secretHash }) => {
    const id = ctx.db.normalizeId("apiKeys", keyId);
    const key = id === null ? null : await ctx.db.get(id);

    if (key === null || !constantTimeEqual(key.secretHash, secretHash)) return null;

    const user = await ctx.db.get(key.userId);
    const now = Date.now();

    if (user === null || !keyWorks(key, user, now)) return null;

    return {
      userId: user._id,
      sessionId: await openSession(ctx, user, { kind: "apiKey", key }, now),
    };
  },
});

/** Stores a new key for the caller. */
export const insert = internalMutation({
  args: {
    name: v.string(),
    scopes: v.array(credentialScope),
    expiresInDays: v.optional(v.number()),
    secretHash: v.string(),
  },
  returns: v.object({ keyId: v.id("apiKeys"), expiresAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, { name, scopes, expiresInDays, secretHash }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const user = (await ctx.db.get(caller.userId)) ?? fail("unauthenticated", "Sign in first");
    const trimmed = name.trim();
    const granted = [...new Set(scopes)];

    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      return fail("invalid_args", `Name the key with 1 to ${NAME_MAX} characters`);
    }

    if (granted.some((scope) => !caller.scopes.includes(scope))) {
      return fail("forbidden", "A key can hold only scopes this session holds");
    }

    if (
      expiresInDays !== undefined &&
      (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > EXPIRY_DAYS_MAX)
    ) {
      return fail("invalid_args", `Keys expire after 1 to ${EXPIRY_DAYS_MAX} days`);
    }

    const expiresAt = expiresInDays === undefined ? null : Date.now() + expiresInDays * DAY_MS;

    const fields = {
      userId: user._id,
      name: trimmed,
      secretHash,
      scopes: granted,
      generation: user.keyGeneration,
    };

    const keyId = await ctx.db.insert(
      "apiKeys",
      expiresAt === null ? fields : { ...fields, expiresAt },
    );

    return { keyId, expiresAt };
  },
});

export const { create, revoke, endAll } = register({
  create: async (ctx, args) => {
    const secret = randomSecret(32);

    const { keyId, expiresAt } = await ctx.runMutation(internal.core.auth.apiKeys.insert, {
      ...args,
      secretHash: await sha256Hex(secret),
    });

    return { keyId, key: formatSecret(PREFIX, keyId, secret), expiresAt };
  },
  revoke: async (ctx, { keyId }, caller) => {
    const key = await ctx.db.get(keyId);

    if (key?.userId !== caller.userId) return fail("not_found", "No such API key");

    await endKeySessions(ctx, keyId);
    await ctx.db.delete(keyId);

    return null;
  },
  endAll: async (ctx, _args, caller) => {
    const user = await ctx.db.get(caller.userId);

    if (user !== null) await endUserKeys(ctx, user);

    return null;
  },
});
