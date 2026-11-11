import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import { PASS_PARAM } from "@media/contracts/sign-in";
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

/** The pass a sign-in carried, checked, for the first mutation of its provider to spend. */
export const spentPass = v.object({ nonce: v.string(), expiresAt: v.number() });

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

  return checked.ok
    ? { own, pass: { nonce: checked.value.nonce, expiresAt: checked.value.expiresAt } }
    : fail("forbidden", REFUSED);
};

/**
 * Records the pass's nonce, at the start of the first mutation its sign-in makes, so the pass
 * works once and its spend commits with the sign-in's first write. A pass spent already refuses
 * the sign-in.
 */
export const spendPass = async (ctx: MutationCtx, pass: CheckedPass): Promise<void> => {
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
 * Spends a pass in a mutation of its own, for a provider whose first write is not one mutation
 * that can spend it, as a tile's proof check is.
 */
export const spend = internalMutation({
  args: { pass: spentPass },
  returns: v.null(),
  handler: async (ctx, { pass }) => {
    await spendPass(ctx, pass);

    return null;
  },
});

/** Forgets nonces of passes the core no longer takes, a batch a call. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ended = await ctx.db
      .query("signInPasses")
      .withIndex("by_expiration", (q) => q.lt("expiresAt", Date.now()))
      .take(SWEEP_BATCH);

    await Promise.all(ended.map((row) => ctx.db.delete(row._id)));

    if (ended.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.core.auth.passes.sweep, {});
    }

    return null;
  },
});
