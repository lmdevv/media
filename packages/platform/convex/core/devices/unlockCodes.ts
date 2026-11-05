import { v } from "convex/values";

import { register } from "../../../commands/core/devices/unlockCodes";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { PASSWORD_MIN, hashUnlockCode } from "../lib/passwords";
import { takeAttempt } from "../lib/rateLimit";
import type { RateLimit } from "../lib/rateLimit";
import { asPerson } from "../accounts/users";
import { requireAccount } from "../permissions/authorize";
import { proverOf } from "../permissions/policy";
import { requireOpen, sharedDeviceById, tilePerson } from "./facts";

/** Wrong unlock codes in a row that turn a person's code off on one device (D47). */
export const CODE_TRIES = 5;

const UNLOCKS_PER_HOUR = 20;

const CODE_DIGITS_MIN = 4;

const CODE_DIGITS_MAX = PASSWORD_MIN - 1;

/** How many digits an unlock code has, as refusals word it. */
export const CODE_DIGITS = `${CODE_DIGITS_MIN} to ${CODE_DIGITS_MAX} digits`;

/** Whether `typed` is an unlock code: {@link CODE_DIGITS}. */
export const isUnlockCode = (typed: string): boolean =>
  typed.length >= CODE_DIGITS_MIN && typed.length <= CODE_DIGITS_MAX && /^\d+$/u.test(typed);

/** Every unlock-code try a person makes, on any device, takes from this bucket. */
export const unlockLimit = (userId: Id<"users">): RateLimit => ({
  identifier: `unlock:${userId}`,
  perHour: UNLOCKS_PER_HOUR,
});

/** A person's unlock code, or null when they have none. */
export const codeOf = (
  db: DatabaseReader,
  userId: Id<"users">,
): Promise<Doc<"unlockCodes"> | null> =>
  db
    .query("unlockCodes")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

const strikeOf = (db: DatabaseReader, deviceId: Id<"devices">, userId: Id<"users">) =>
  db
    .query("unlockStrikes")
    .withIndex("by_device_user", (q) => q.eq("deviceId", deviceId).eq("userId", userId))
    .unique();

const wrongTries = (code: Doc<"unlockCodes">, strike: Doc<"unlockStrikes"> | null): number =>
  strike?.codeId === code._id ? strike.wrong : 0;

/** Whether a person's code works on a device: none set, ready, or off after 5 wrong tries. */
export const codeStateOn = async (
  db: DatabaseReader,
  deviceId: Id<"devices">,
  userId: Id<"users">,
): Promise<"none" | "ready" | "off"> => {
  const code = await codeOf(db, userId);

  if (code === null) return "none";

  return wrongTries(code, await strikeOf(db, deviceId, userId)) >= CODE_TRIES ? "off" : "ready";
};

/**
 * Turns a person's code back on for a device: a password typed there, an approval from another
 * device, a right code, or an admin's reset (D47).
 */
export const clearStrikes = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  userId: Id<"users">,
): Promise<void> => {
  const strike = await strikeOf(ctx.db, deviceId, userId);

  if (strike !== null) await ctx.db.delete(strike._id);
};

/**
 * Takes one wrong try before the action checks the digits, so tries made at once never pass 5,
 * and a right code gives it back by clearing the count. A code that could not open the tile even
 * when right is refused first and costs no try.
 */
export const attempt = internalMutation({
  args: { deviceId: v.string(), secretHash: v.string(), userId: v.id("users"), by: v.id("users") },
  returns: v.union(
    v.object({ kind: v.literal("none") }),
    v.object({ kind: v.literal("off") }),
    v.object({ kind: v.literal("limited") }),
    v.object({
      kind: v.literal("ready"),
      codeId: v.id("unlockCodes"),
      hash: v.string(),
      left: v.number(),
    }),
  ),
  handler: async (ctx, { deviceId, secretHash, userId, by }) => {
    const device = await sharedDeviceById(ctx.db, deviceId, secretHash);
    const typist = asPerson(await ctx.db.get(by));
    const code = typist === null ? null : await codeOf(ctx.db, typist._id);

    if (typist === null || code === null) return { kind: "none" as const };

    await requireOpen(ctx.db, device, await tilePerson(ctx.db, userId), proverOf(typist));

    const strike = await strikeOf(ctx.db, device._id, by);
    const wrong = wrongTries(code, strike);

    if (wrong >= CODE_TRIES) return { kind: "off" as const };

    if (!(await takeAttempt(ctx, unlockLimit(by), Date.now()))) {
      return { kind: "limited" as const };
    }

    const counted = { deviceId: device._id, userId: by, codeId: code._id, wrong: wrong + 1 };

    if (strike === null) await ctx.db.insert("unlockStrikes", counted);
    else await ctx.db.replace(strike._id, counted);

    return {
      kind: "ready" as const,
      codeId: code._id,
      hash: code.hash,
      left: CODE_TRIES - wrong - 1,
    };
  },
});

/** Replaces the caller's unlock code with `hash`, or removes it. A new code starts with no strikes. */
export const store = internalMutation({
  args: { hash: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { hash }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const current = await codeOf(ctx.db, caller.userId);

    if (current !== null) await ctx.db.delete(current._id);

    if (hash !== null) await ctx.db.insert("unlockCodes", { userId: caller.userId, hash });

    return null;
  },
});

export const { set, reset } = register({
  set: async (ctx, { code }) => {
    if (code === null) {
      await ctx.runMutation(internal.core.devices.unlockCodes.store, { hash: null });

      return null;
    }

    const digits = code.trim();

    if (!isUnlockCode(digits)) {
      return fail("invalid_args", `Use ${CODE_DIGITS} for the unlock code`);
    }

    await ctx.runMutation(internal.core.devices.unlockCodes.store, {
      hash: await hashUnlockCode(digits),
    });

    return null;
  },
  reset: async (ctx, { deviceId, userId }, caller) => {
    await requireAccount(ctx, caller, "resetUnlockCode", userId);
    await clearStrikes(ctx, deviceId, userId);

    return null;
  },
});
