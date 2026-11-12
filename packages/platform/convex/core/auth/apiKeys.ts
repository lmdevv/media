import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";

import { register } from "../../../commands/core/auth/apiKeys";
import { credentialScope, credentialScopes } from "../../../commands/scopes";
import type { CredentialScope } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { GIVEN_NAME_MAX, requireGivenName } from "../lib/names";
import { PAGE_ROWS_MAX, paginateAtMost } from "../lib/paginate";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { endKeySessions, endUserKeys, keyWorks, openSession } from "../sessions";
import type { SignedIn } from "../sessions";
import { LIST_CALL_READS } from "../permissions/grants";
import { callerUser, refuseKeys, requireCaller } from "./caller";
import { behindBoundary, spendPass, spentPass } from "./passes";
import { requireOwnCredential } from "./sessions";

const PREFIX = "mk";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_DAYS_MAX = 365;

const BAD_KEY = "This API key does not work";

const WORKING_SERVICE_KEYS_MAX = 4;

const NO_KEY = "No such API key";

const LIST_ROW_READS = 1;

const LIST_ROWS = Math.floor((PAGE_ROWS_MAX - LIST_CALL_READS) / LIST_ROW_READS);

const isCredentialScope = (scope: string): scope is CredentialScope =>
  credentialScopes.some((known) => known === scope);

const retirement = v.union(v.literal("on-first-use"), v.literal("now"));

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
export const apiKeyProvider = behindBoundary({
  id: "apiKey",
  authorize: async (params, ctx, pass): Promise<SignedIn> => {
    const { key } = await ctx.runQuery(parseKeyParams, params);
    const parsed = parseSecret(PREFIX, key);

    if (parsed === null) return fail("unauthenticated", BAD_KEY);

    const opened: SignedIn | null = await ctx.runMutation(internal.core.auth.apiKeys.redeem, {
      pass,
      keyId: parsed.rowId,
      secretHash: await sha256Hex(parsed.secret),
    });

    return opened ?? fail("unauthenticated", BAD_KEY);
  },
});

const deleteKey = async (ctx: Pick<MutationCtx, "db">, keyId: Id<"apiKeys">): Promise<void> => {
  await endKeySessions(ctx, keyId);
  await ctx.db.delete(keyId);
};

const retireKeysBefore = async (
  ctx: Pick<MutationCtx, "db">,
  key: Doc<"apiKeys">,
): Promise<void> => {
  const earlier = await ctx.db
    .query("apiKeys")
    .withIndex("by_user", (q) => q.eq("userId", key.userId).lt("_creationTime", key._creationTime))
    .collect();

  await Promise.all(earlier.map((retired) => deleteKey(ctx, retired._id)));
};

/**
 * Signs in with a key into a new session of its own. Null when the key fails. A service's key
 * retires the service's earlier keys, so the first sign-in with a new key completes a rotation.
 */
export const redeem = internalMutation({
  args: {
    pass: spentPass,
    keyId: v.string(),
    secretHash: v.string(),
  },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { pass, keyId, secretHash }) => {
    await spendPass(ctx, pass, "apiKey");

    const id = ctx.db.normalizeId("apiKeys", keyId);
    const key = id === null ? null : await ctx.db.get(id);

    if (key === null || !constantTimeEqual(key.secretHash, secretHash)) return null;

    const user = await ctx.db.get(key.userId);
    const now = Date.now();

    if (user === null || !keyWorks(key, user, now)) return null;

    if (user.kind === "service") await retireKeysBefore(ctx, key);

    await ctx.db.patch(key._id, { lastUsedAt: now });

    return {
      userId: user._id,
      sessionId: await openSession(ctx, user, { kind: "apiKey", key }, now),
    };
  },
});

/**
 * Stores a new key for a service, holding `media-service` and never expiring. With
 * `on-first-use`, the service's earlier keys keep working until this key first signs in, so the
 * server keeps running while the operator swaps its key. With `now`, they and their sessions end
 * in this transaction, for a key that leaked.
 */
export const storeServiceKey = internalMutation({
  args: { serviceId: v.id("users"), retire: retirement, secretHash: v.string() },
  returns: v.id("apiKeys"),
  handler: async (ctx, { serviceId, retire, secretHash }) => {
    const service = await ctx.db.get(serviceId);

    if (service?.kind !== "service") return fail("not_found", "No such service");

    const now = Date.now();

    const held = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", serviceId))
      .collect();

    if (retire === "now") {
      await Promise.all(held.map((key) => deleteKey(ctx, key._id)));
    } else if (
      held.filter((key) => keyWorks(key, service, now)).length >= WORKING_SERVICE_KEYS_MAX
    ) {
      return fail(
        "conflict",
        `This service already holds ${WORKING_SERVICE_KEYS_MAX} keys; sign the server in with its newest key, or issue one with retire now`,
      );
    }

    return ctx.db.insert("apiKeys", {
      userId: serviceId,
      name: service.name,
      secretHash,
      scopes: ["media-service"],
      generation: service.keyGeneration,
    });
  },
});

/**
 * Issues an API key for a service and returns it, the only time it is shown; the core stores its
 * hash. A host function: the operator runs it with `convex run` and hands the key to the server.
 * `retire` defaults to `on-first-use`.
 */
export const issueServiceKey = internalAction({
  args: { serviceId: v.id("users"), retire: v.optional(retirement) },
  returns: v.object({ keyId: v.id("apiKeys"), key: v.string() }),
  handler: async (ctx, { serviceId, retire }) => {
    const secret = randomSecret(32);

    const keyId: Id<"apiKeys"> = await ctx.runMutation(internal.core.auth.apiKeys.storeServiceKey, {
      serviceId,
      retire: retire ?? "on-first-use",
      secretHash: await sha256Hex(secret),
    });

    return { keyId, key: formatSecret(PREFIX, keyId, secret) };
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
    const user = await callerUser(ctx, caller);

    const named = requireGivenName(
      name,
      `Name the key with 1 to ${GIVEN_NAME_MAX} printable characters`,
    );

    const granted = [...new Set(scopes)];

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
      name: named,
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

export const { create, list, revoke, endAll } = register({
  create: async (ctx, args) => {
    const secret = randomSecret(32);

    const { keyId, expiresAt } = await ctx.runMutation(internal.core.auth.apiKeys.insert, {
      ...args,
      secretHash: await sha256Hex(secret),
    });

    return { keyId, key: formatSecret(PREFIX, keyId, secret), expiresAt };
  },
  /**
   * The caller's keys that still work or ran out, newest first. Ended keys wait for the purge and
   * are left out, so a page may hold fewer rows than asked.
   */
  list: async (ctx, { paginationOpts }, caller) => {
    requireOwnCredential(caller, "list", caller.userId, NO_KEY);

    const user = await callerUser(ctx, caller);

    const page = await paginateAtMost(
      ctx.db,
      { table: "apiKeys", index: "by_user", range: (q) => q.eq("userId", user._id), order: "desc" },
      paginationOpts,
      LIST_ROWS,
    );

    return {
      ...page,
      page: page.page.flatMap((key) =>
        key.generation === user.keyGeneration
          ? [
              {
                keyId: key._id,
                name: key.name,
                scopes: key.scopes.filter(isCredentialScope),
                createdAt: key._creationTime,
                expiresAt: key.expiresAt ?? null,
                lastUsedAt: key.lastUsedAt ?? null,
              },
            ]
          : [],
      ),
    };
  },
  revoke: async (ctx, { keyId }, caller) => {
    const key = (await ctx.db.get(keyId)) ?? fail("not_found", NO_KEY);

    requireOwnCredential(caller, "end", key.userId, NO_KEY);

    await deleteKey(ctx, keyId);

    return null;
  },
  endAll: async (ctx, _args, caller) => {
    requireOwnCredential(caller, "end", caller.userId, NO_KEY);

    const user = await ctx.db.get(caller.userId);

    if (user !== null) await endUserKeys(ctx, user);

    return null;
  },
});
