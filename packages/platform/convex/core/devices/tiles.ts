import { v } from "convex/values";
import type { Infer } from "convex/values";

import { register } from "../../../commands/core/devices/tiles";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { asPerson } from "../accounts/users";
import { fail } from "../lib/errors";
import { passwordHashOf, signInLimit } from "../lib/passwords";
import { refundAttempt } from "../lib/rateLimit";
import { requireAccount } from "../permissions/authorize";
import { proverOf } from "../permissions/policy";
import type { PersonDoc } from "../permissions/policy";
import { openSession, signedIn } from "../sessions";
import { markRedeemed, redeemable } from "./approvals";
import type { Redeemed } from "./approvals";
import {
  LISTED_MAX,
  listedPeople,
  occupyTile,
  requireOpen,
  requireTile,
  sharedDeviceById,
  tilePerson,
} from "./facts";
import type { SharedDevice } from "./facts";
import { clearStrikes, codeOf } from "./unlockCodes";
import { spendPass, spentPass } from "../auth/passes";

/** A proof the provider checked, which `open` checks again against the rows it reads. */
export const checkedProof = v.union(
  v.object({ kind: v.literal("none") }),
  v.object({
    kind: v.literal("password"),
    by: v.id("users"),
    hash: v.string(),
    usernameKey: v.string(),
  }),
  v.object({ kind: v.literal("code"), by: v.id("users"), codeId: v.id("unlockCodes") }),
  v.object({ kind: v.literal("approval"), approvalId: v.id("tileApprovals") }),
);

/** A proof the `tile` provider checked. */
export type CheckedProof = Infer<typeof checkedProof>;

const proverFor = async (
  ctx: Pick<MutationCtx, "db">,
  device: SharedDevice,
  person: PersonDoc,
  proof: CheckedProof,
  now: number,
): Promise<Redeemed | { readonly kind: "none" }> => {
  if (proof.kind === "none") return { kind: "none" };

  if (proof.kind === "approval") return redeemable(ctx, proof.approvalId, device, person, now);

  const by = asPerson(await ctx.db.get(proof.by)) ?? fail("unauthenticated", "Wrong password");

  const unchanged =
    proof.kind === "password"
      ? (await passwordHashOf(ctx.db, by._id)) === proof.hash
      : (await codeOf(ctx.db, by._id))?._id === proof.codeId;

  return unchanged
    ? { kind: "prover", prover: proverOf(by) }
    : fail("unauthenticated", "That changed meanwhile; try again");
};

/** Opens `userId`'s tile with a checked proof, ending the tile session the device held. */
export const open = internalMutation({
  args: {
    /** The sign-in's pass, unless a proof's mutation spent it already. */
    pass: v.union(v.null(), spentPass),
    deviceId: v.string(),
    secretHash: v.string(),
    userId: v.id("users"),
    proof: checkedProof,
  },
  returns: signedIn,
  handler: async (ctx, { pass, deviceId, secretHash, userId, proof }) => {
    if (pass !== null) await spendPass(ctx, pass, "tile");
    const device = await sharedDeviceById(ctx.db, deviceId, secretHash);
    const person = await tilePerson(ctx.db, userId);
    const now = Date.now();
    const proved = await proverFor(ctx, device, person, proof, now);

    if (proved.kind === "again") return proved.signedIn;

    const prover = proved.kind === "prover" ? proved.prover : null;

    await requireOpen(ctx.db, device, person, prover);

    const sessionId = await openSession(ctx, person, { kind: "tile", device }, now);

    await occupyTile(ctx, device, { userId: person._id, sessionId });

    if (prover !== null) await clearStrikes(ctx, device._id, prover.userId);

    if (proof.kind === "password") await refundAttempt(ctx, signInLimit(proof.usernameKey), now);

    if (proof.kind === "approval") await markRedeemed(ctx, proof.approvalId, sessionId);

    return { userId: person._id, sessionId };
  },
});

export const { setListed, setLock } = register({
  setListed: async (ctx, { userId, listed }, caller) => {
    const person = await requireAccount(ctx, caller, "listOnSharedDevices", userId);

    if ((person.sharedDevices === true) === listed) return null;

    if (listed && (await listedPeople(ctx.db)).length >= LISTED_MAX) {
      return fail("conflict", `Shared devices list at most ${LISTED_MAX} people`);
    }

    await ctx.db.patch(person._id, { sharedDevices: listed ? true : undefined });

    return null;
  },
  setLock: async (ctx, { userId, locked }, caller) => {
    const person = await requireTile(ctx, caller, locked ? "lock" : "unlock", userId);

    if ((person.tileLock === true) !== locked) {
      await ctx.db.patch(person._id, { tileLock: locked ? true : undefined });
    }

    return null;
  },
});
