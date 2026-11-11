import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import { PASS_PARAM, SPENT_PASS_KEPT_MS } from "@media/contracts/sign-in";
import type { SignInProvider } from "@media/contracts/sign-in";
import { convexToJson, v } from "convex/values";
import type { Infer, Value } from "convex/values";

import { internal } from "../../_generated/api";
import type { DataModel } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import type { SignedIn } from "../sessions";
import { passKeys } from "../tickets";

type Params = Partial<Record<string, Value | undefined>>;

type ActionCtx = GenericActionCtxWithAuthConfig<DataModel>;

const REFUSED = "Sign in through the server: the core takes sign-ins only from its sign-in route";

const SWEEP_BATCH = 1000;

/**
 * The pass a sign-in carried, checked against its key, for the first mutation of its provider to
 * spend: the nonce, when it expires, the provider it was signed for, and its address's digest.
 */
export const spentPass = v.object({
  nonce: v.string(),
  expiresAt: v.number(),
  provider: v.string(),
  addressDigest: v.string(),
});

/** A checked pass, as `spentPass` holds it. */
export type CheckedPass = Infer<typeof spentPass>;

/**
 * Checks the pass the server's boundary signed for this sign-in (ADR 0007). Answers the provider's
 * own params, without the pass, and the pass for its first mutation to spend. Every refusal reads
 * the same: `forbidden`.
 */
const checkPass = async (
  provider: SignInProvider,
  params: Params,
): Promise<{ readonly own: Params; readonly pass: CheckedPass }> => {
  const { [PASS_PARAM]: pass, ...own } = params;

  const checked = await (
    await passKeys()
  ).verify(pass === undefined ? null : convexToJson(pass), provider, convexToJson(own), Date.now());

  return checked.ok ? { own, pass: { ...checked.value, provider } } : fail("forbidden", REFUSED);
};

/**
 * Spends the pass at the start of the first mutation its sign-in makes, so its spend commits with
 * the sign-in's first write. Everything about the pass that needs no key is decided here, in the
 * same transaction as the nonce and the writes it guards: the pass is for `provider`, it has not
 * expired by this mutation's clock, and no sign-in spent its nonce. The action checked the key,
 * and the expiry there only spares a call; the one that counts is here, so a call delayed past
 * expiry is refused whatever the sweep has forgotten.
 */
export const spendPass = async (
  ctx: MutationCtx,
  pass: CheckedPass,
  provider: SignInProvider,
): Promise<void> => {
  if (pass.provider !== provider || Date.now() >= pass.expiresAt) {
    return fail("forbidden", REFUSED);
  }

  const seen = await ctx.db
    .query("signInPasses")
    .withIndex("by_nonce", (q) => q.eq("nonce", pass.nonce))
    .unique();

  if (seen !== null) return fail("forbidden", REFUSED);

  await ctx.db.insert("signInPasses", pass);
};

/**
 * A Convex Auth credentials provider that takes a sign-in only with a pass from the server's
 * boundary (`@media/contracts/sign-in`). Every provider of the core is one, so no sign-in skips
 * the boundary's per-address limit. The provider hands `pass` to the first mutation it makes,
 * which spends it with `spendPass` before it writes anything else. A refresh never reaches a
 * provider, so it needs no pass.
 */
export const behindBoundary = (provider: {
  readonly id: SignInProvider;
  readonly authorize: (params: Params, ctx: ActionCtx, pass: CheckedPass) => Promise<SignedIn>;
}) =>
  ConvexCredentials<DataModel>({
    id: provider.id,
    authorize: async (params, ctx) => {
      const { own, pass } = await checkPass(provider.id, params);

      return provider.authorize(own, ctx, pass);
    },
  });

/**
 * Forgets nonces of passes expired more than `SPENT_PASS_KEPT_MS` ago, a batch a call. Their
 * spender refuses them by expiry alone by then, so forgetting the nonce re-opens nothing.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ended = await ctx.db
      .query("signInPasses")
      .withIndex("by_expiration", (q) => q.lt("expiresAt", Date.now() - SPENT_PASS_KEPT_MS))
      .take(SWEEP_BATCH);

    await Promise.all(ended.map((row) => ctx.db.delete(row._id)));

    if (ended.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.core.auth.passes.sweep, {});
    }

    return null;
  },
});
