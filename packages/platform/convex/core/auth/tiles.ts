import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Infer, Value } from "convex/values";

import { internal } from "../../_generated/api";
import type { DataModel, Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { asPerson } from "../accounts/users";
import { proverOf } from "../permissions/policy";
import {
  DEVICE_PREFIX,
  NO_DEVICE,
  requireOpen,
  sharedDeviceById,
  tilePerson,
} from "../devices/facts";
import { isUnlockCode } from "../devices/unlockCodes";
import type { CheckedProof } from "../devices/tiles";
import { fail } from "../lib/errors";
import { PASSWORD_MAX, passwordHashOf, passwordMatches, signInLimit } from "../lib/passwords";
import { takeAttempt } from "../lib/rateLimit";
import { parseSecret, sha256Hex } from "../lib/secrets";
import type { SignedIn } from "../sessions";

const tileProof = v.union(
  v.object({ kind: v.literal("password"), by: v.id("users"), password: v.string() }),
  v.object({ kind: v.literal("code"), by: v.id("users"), code: v.string() }),
  v.object({ kind: v.literal("approval"), approvalId: v.id("tileApprovals") }),
);

const tileParams = { device: v.string(), userId: v.id("users"), proof: v.optional(tileProof) };

const tileParamsObject = v.object(tileParams);

/** Checks the sign-in params' shape. */
export const parse = internalQuery({
  args: tileParams,
  returns: tileParamsObject,
  handler: (_ctx, args) => args,
});

const parseTileParams = makeFunctionReference<
  "query",
  Partial<Record<string, Value | undefined>>,
  Infer<typeof tileParamsObject>
>("core/auth/tiles:parse");

/** The shared device a sign-in names, and whose tile it opens. */
interface TileKey {
  readonly deviceId: string;
  readonly secretHash: string;
  readonly userId: Id<"users">;
}

const WRONG_PASSWORD = "Wrong password";

/** Takes a sign-in try for the person typing their password on a lock screen, and finds the hash. */
export const passwordAttempt = internalMutation({
  args: { deviceId: v.string(), secretHash: v.string(), userId: v.id("users"), by: v.id("users") },
  returns: v.union(
    v.object({ kind: v.literal("limited") }),
    v.object({ kind: v.literal("unknown") }),
    v.object({ kind: v.literal("known"), hash: v.string(), usernameKey: v.string() }),
  ),
  handler: async (ctx, { deviceId, secretHash, userId, by }) => {
    const device = await sharedDeviceById(ctx.db, deviceId, secretHash);
    const person = asPerson(await ctx.db.get(by));

    if (person === null) return { kind: "unknown" as const };

    await requireOpen(ctx.db, device, await tilePerson(ctx.db, userId), proverOf(person));

    if (!(await takeAttempt(ctx, signInLimit(person.usernameKey), Date.now()))) {
      return { kind: "limited" as const };
    }

    const hash = await passwordHashOf(ctx.db, by);

    return hash === undefined
      ? { kind: "unknown" as const }
      : { kind: "known" as const, hash, usernameKey: person.usernameKey };
  },
});

const checkPassword = async (
  ctx: Pick<ActionCtx, "runMutation">,
  key: TileKey,
  by: Id<"users">,
  password: string,
): Promise<CheckedProof> => {
  if (password.length > PASSWORD_MAX) {
    return fail("invalid_args", `Use at most ${PASSWORD_MAX} characters for the password`);
  }

  const attempt = await ctx.runMutation(internal.core.auth.tiles.passwordAttempt, {
    ...key,
    by,
  });

  if (attempt.kind === "limited") {
    return fail("rate_limited", "Too many password tries; wait a few minutes and try again");
  }

  if (attempt.kind === "unknown" || !(await passwordMatches(attempt.hash, password))) {
    return fail("unauthenticated", WRONG_PASSWORD);
  }

  return { kind: "password", by, hash: attempt.hash, usernameKey: attempt.usernameKey };
};

const checkCode = async (
  ctx: Pick<ActionCtx, "runMutation">,
  key: TileKey,
  by: Id<"users">,
  code: string,
): Promise<CheckedProof> => {
  const digits = code.trim();

  if (!isUnlockCode(digits)) return fail("invalid_args", "An unlock code is 4 to 8 digits");

  const attempt = await ctx.runMutation(internal.core.devices.unlockCodes.attempt, { ...key, by });

  if (attempt.kind === "none")
    return fail("unauthenticated", "No unlock code is set for this person");

  if (attempt.kind === "off") {
    return fail(
      "forbidden",
      "This unlock code is off on this device after 5 wrong tries; type the password or approve from another device",
    );
  }

  if (attempt.kind === "limited") {
    return fail("rate_limited", "Too many unlock code tries; wait a few minutes and try again");
  }

  if (!(await passwordMatches(attempt.hash, digits))) {
    return fail(
      "unauthenticated",
      attempt.left === 0
        ? "Wrong unlock code; it is now off on this device"
        : `Wrong unlock code; ${attempt.left} tries left on this device`,
    );
  }

  return { kind: "code", by, codeId: attempt.codeId };
};

/**
 * The `tile` provider: opens a person's tile on a shared device as a new media-only session. The
 * proof is absent for an open tile, or a password, an unlock code, or an approval for a locked one.
 */
export const tileProvider = ConvexCredentials<DataModel>({
  id: "tile",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { device, userId, proof } = await ctx.runQuery(parseTileParams, params);
    const parsed = parseSecret(DEVICE_PREFIX, device.trim()) ?? fail("not_found", NO_DEVICE);
    const key = { deviceId: parsed.rowId, secretHash: await sha256Hex(parsed.secret), userId };

    const checked: CheckedProof =
      proof === undefined
        ? { kind: "none" }
        : proof.kind === "password"
          ? await checkPassword(ctx, key, proof.by, proof.password)
          : proof.kind === "code"
            ? await checkCode(ctx, key, proof.by, proof.code)
            : proof;

    return ctx.runMutation(internal.core.devices.tiles.open, { ...key, proof: checked });
  },
});
