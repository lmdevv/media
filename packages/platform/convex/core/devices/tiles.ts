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
import { can, lockOf, principalOf, proverOf } from "../permissions/policy";
import type { PersonDoc, TileResource } from "../permissions/policy";
import { openSession, signedIn } from "../sessions";
import { markRedeemed, redeemable } from "./approvals";
import type { Redeemed } from "./approvals";
import {
  LISTED_MAX,
  NO_TILE,
  holderOf,
  listedPeople,
  occupyTile,
  requireTile,
  sharedDeviceById,
  tileOf,
} from "./facts";
import type { SharedDevice } from "./facts";
import { clearStrikes, codeOf, unlockLimit } from "./unlockCodes";

/** A proof the provider checked, which `open` checks again against the rows it reads. */
export const checkedProof = v.union(
  v.object({ kind: v.literal("none") }),
  v.object({ kind: v.literal("password"), by: v.id("users"), hash: v.string() }),
  v.object({ kind: v.literal("code"), by: v.id("users"), codeId: v.id("unlockCodes") }),
  v.object({ kind: v.literal("approval"), approvalId: v.id("tileApprovals") }),
);

/** A proof the `tile` provider checked. */
export type CheckedProof = Infer<typeof checkedProof>;

/** The person a checked proof names, read again; a password or code changed meanwhile refuses. */
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

const lockedMessage = (tile: TileResource): string => {
  const lock = lockOf(tile);

  if (lock.state === "locked" && lock.opensWith === "adult") {
    return "An adult approves leaving a kid's tile, or proves who they are for this one";
  }

  return "This tile is locked; type the password or unlock code, or approve from another device";
};

/** Opens `userId`'s tile with a checked proof, ending the tile session the device held. */
export const open = internalMutation({
  args: {
    deviceId: v.string(),
    secretHash: v.string(),
    userId: v.id("users"),
    proof: checkedProof,
  },
  returns: signedIn,
  handler: async (ctx, { deviceId, secretHash, userId, proof }) => {
    const device = await sharedDeviceById(ctx.db, deviceId, secretHash);
    const person = asPerson(await ctx.db.get(userId)) ?? fail("not_found", NO_TILE);
    const now = Date.now();
    const proved = await proverFor(ctx, device, person, proof, now);

    if (proved.kind === "again") return proved.signedIn;

    const prover = proved.kind === "prover" ? proved.prover : null;
    const listed = await listedPeople(ctx.db);
    const tile = tileOf(person, listed, holderOf(device, listed), prover);
    const decision = can(principalOf(person), "open", tile);

    if (!decision.allowed) {
      return decision.refusal === "hidden"
        ? fail("not_found", NO_TILE)
        : fail("forbidden", lockedMessage(tile));
    }

    const sessionId = await openSession(ctx, person, { kind: "tile", device }, now);

    await occupyTile(ctx, device, { userId: person._id, sessionId });

    if (prover !== null) await clearStrikes(ctx, device._id, prover.userId);

    if (proof.kind === "password") {
      const by = asPerson(await ctx.db.get(proof.by));

      if (by !== null) await refundAttempt(ctx, signInLimit(by.usernameKey), now);
    }

    if (proof.kind === "code") await refundAttempt(ctx, unlockLimit(proof.by), now);

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
