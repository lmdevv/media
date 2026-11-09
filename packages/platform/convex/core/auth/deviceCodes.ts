import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Infer, Value } from "convex/values";

import { register } from "../../../commands/core/auth/deviceCodes";
import { internal } from "../../_generated/api";
import type { DataModel, Doc } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { requireDeviceName } from "../lib/names";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { liveSession, openSession } from "../sessions";
import type { SignedIn } from "../sessions";
import { callerUser } from "./caller";

const PREFIX = "dc";

const CODE_MS = 10 * 60 * 1000;

const POLL_SECONDS = 5;

const WAITING_MAX = 50;

const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

const randomUserCode = (): string => {
  const unbiasedBelow = 256 - (256 % USER_CODE_LETTERS.length);

  const letters = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .filter((byte) => byte < unbiasedBelow)
    .slice(0, 8)
    .map((byte) => USER_CODE_LETTERS.charAt(byte % USER_CODE_LETTERS.length))
    .join("");

  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : randomUserCode();
};

const normalizeUserCode = (typed: string): string => {
  const letters = typed.toUpperCase().replaceAll(/[^A-Z]/gu, "");

  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
};

type DeviceCode = Doc<"deviceCodes">;

type DeviceCodeState = DeviceCode["state"] | "expired";

const stateOf = (code: DeviceCode, now: number): DeviceCodeState =>
  code.expiresAt <= now ? "expired" : code.state;

const newestByUserCode = async (
  ctx: Pick<QueryCtx, "db">,
  typed: string,
): Promise<DeviceCode | null> =>
  ctx.db
    .query("deviceCodes")
    .withIndex("by_user_code", (q) => q.eq("userCode", normalizeUserCode(typed)))
    .order("desc")
    .first();

const pending = async (ctx: Pick<QueryCtx, "db">, typed: string, now: number) => {
  const code =
    (await newestByUserCode(ctx, typed)) ?? fail("not_found", "No device is waiting for that code");

  const state = stateOf(code, now);

  if (state === "expired")
    return fail("expired", "This code has expired; start again on the device");

  return code.state === "pending" ? code : fail("conflict", "This code was already used");
};

const REFUSALS = {
  pending: "Waiting for someone to approve this device",
  denied: "This device sign-in was refused",
  expired: "This device code has expired; start again",
} as const;

const redemption = v.union(
  v.object({ kind: v.literal("signedIn"), userId: v.id("users"), sessionId: v.id("authSessions") }),
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("denied") }),
  v.object({ kind: v.literal("expired") }),
);

const deviceParams = { deviceCode: v.string() };

const parseDeviceParams = makeFunctionReference<
  "query",
  Partial<Record<string, Value | undefined>>,
  { readonly deviceCode: string }
>("core/auth/deviceCodes:parse");

/** Checks the sign-in params' shape. */
export const parse = internalQuery({
  args: deviceParams,
  returns: v.object(deviceParams),
  handler: (_ctx, args) => args,
});

/** The device code provider. */
export const deviceCodeProvider = ConvexCredentials<DataModel>({
  id: "deviceCode",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { deviceCode } = await ctx.runQuery(parseDeviceParams, params);
    const parsed = parseSecret(PREFIX, deviceCode);

    const redeemed: Infer<typeof redemption> =
      parsed === null
        ? { kind: "expired" as const }
        : await ctx.runMutation(internal.core.auth.deviceCodes.redeem, {
            codeId: parsed.rowId,
            secretHash: await sha256Hex(parsed.secret),
          });

    return redeemed.kind === "signedIn"
      ? { userId: redeemed.userId, sessionId: redeemed.sessionId }
      : fail(redeemed.kind, REFUSALS[redeemed.kind]);
  },
});

/**
 * Signs a device in with an approved code, and into the same session again until the code
 * expires, so a lost answer costs only a retry. An unknown or voided code reads as `expired`.
 */
export const redeem = internalMutation({
  args: { codeId: v.string(), secretHash: v.string() },
  returns: redemption,
  handler: async (ctx, { codeId, secretHash }) => {
    const id = ctx.db.normalizeId("deviceCodes", codeId);
    const code = id === null ? null : await ctx.db.get(id);
    const now = Date.now();

    if (code === null || !constantTimeEqual(code.secretHash, secretHash) || code.expiresAt <= now) {
      return { kind: "expired" as const };
    }

    if (code.state === "pending" || code.state === "denied") return { kind: code.state };

    if (code.state === "redeemed") {
      return (await liveSession(ctx.db, code.sessionId, now)) === null
        ? { kind: "expired" as const }
        : { kind: "signedIn" as const, userId: code.approvedBy, sessionId: code.sessionId };
    }

    const approver = await ctx.db.get(code.approvedBy);

    if (approver === null || approver.sessionGeneration !== code.generation) {
      return { kind: "expired" as const };
    }

    const sessionId = await openSession(ctx, approver, { kind: "deviceCode", code }, now);

    await ctx.db.replace(code._id, {
      secretHash: code.secretHash,
      userCode: code.userCode,
      clientName: code.clientName,
      expiresAt: code.expiresAt,
      state: "redeemed",
      approvedBy: approver._id,
      sessionId,
    });

    return { kind: "signedIn" as const, userId: approver._id, sessionId };
  },
});

/** Stores a new device code. */
export const insert = internalMutation({
  args: { secretHash: v.string(), userCode: v.string(), clientName: v.string() },
  returns: v.object({ codeId: v.id("deviceCodes"), expiresAt: v.number() }),
  handler: async (ctx, { secretHash, userCode, clientName }) => {
    const now = Date.now();

    const name = requireDeviceName(clientName);

    const waiting = await ctx.db
      .query("deviceCodes")
      .withIndex("by_expiration", (q) => q.gt("expiresAt", now))
      .take(WAITING_MAX + 1);

    if (waiting.length > WAITING_MAX) {
      return fail(
        "rate_limited",
        "Too many devices are waiting to sign in; try again in a few minutes",
      );
    }

    if (waiting.some((code) => code.userCode === userCode)) {
      return fail("conflict", "That user code is taken; start again");
    }

    const expiresAt = now + CODE_MS;

    const codeId = await ctx.db.insert("deviceCodes", {
      secretHash,
      userCode,
      clientName: name,
      expiresAt,
      state: "pending",
    });

    return { codeId, expiresAt };
  },
});

export const { start, lookup, approve, deny } = register({
  start: async (ctx, { clientName }) => {
    const secret = randomSecret(32);
    const userCode = randomUserCode();

    const { codeId, expiresAt } = await ctx.runMutation(internal.core.auth.deviceCodes.insert, {
      secretHash: await sha256Hex(secret),
      userCode,
      clientName,
    });

    return {
      deviceCode: formatSecret(PREFIX, codeId, secret),
      userCode,
      expiresAt,
      intervalSeconds: POLL_SECONDS,
    };
  },
  lookup: async (ctx, { userCode }) => {
    const code =
      (await newestByUserCode(ctx, userCode)) ??
      fail("not_found", "No device is waiting for that code");

    return {
      clientName: code.clientName,
      state: stateOf(code, Date.now()),
      expiresAt: code.expiresAt,
    };
  },
  approve: async (ctx, { userCode, scopes }, caller) => {
    const code = await pending(ctx, userCode, Date.now());
    const approver = await callerUser(ctx, caller);
    const granted = [...new Set(scopes)];

    if (granted.some((scope) => !caller.scopes.includes(scope))) {
      return fail("forbidden", "A device can hold only scopes this session holds");
    }

    await ctx.db.replace(code._id, {
      secretHash: code.secretHash,
      userCode: code.userCode,
      clientName: code.clientName,
      expiresAt: code.expiresAt,
      state: "approved",
      approvedBy: approver._id,
      scopes: granted,
      generation: approver.sessionGeneration,
    });

    return null;
  },
  deny: async (ctx, { userCode }) => {
    const code = await pending(ctx, userCode, Date.now());

    await ctx.db.patch(code._id, { state: "denied" });

    return null;
  },
});
