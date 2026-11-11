import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { member, sharedAdmin, sharedDevice } from "../../devices";
import { importRows, newestRows } from "../../rows";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and this
// one is the `_id` of an `unlockCodes` row as `convex data` printed it, which `v.id("unlockCodes")`
// checks again whenever the test sends it.
const isCodeId = (value: unknown): value is Id<"unlockCodes"> => Schema.is(Schema.String)(value);

const Row = Schema.Struct({ _id: Schema.declare(isCodeId), userId: Schema.String });

const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row));

/** The id of `userId`'s unlock code now. */
const codeIdOf = (userId: string): Id<"unlockCodes"> => {
  const line = newestRows("unlockCodes", 1000).find((row) => decodeRow(row).userId === userId);

  if (line === undefined) throw new Error(`${userId} has no unlock code`);

  return decodeRow(line)._id;
};

const Strike = Schema.Struct({
  deviceId: Schema.String,
  userId: Schema.String,
  codeId: Schema.String,
  wrong: Schema.Finite,
});

const decodeStrike = Schema.decodeUnknownSync(Schema.fromJsonString(Strike));

/** The strikes of `userId` on `deviceId`: the code they count against and how many. */
const strikesOf = (deviceId: string, userId: string) =>
  newestRows("unlockStrikes", 1000)
    .map((row) => decodeStrike(row))
    .find((strike) => strike.deviceId === deviceId && strike.userId === userId);

const Budget = Schema.Struct({
  identifier: Schema.String,
  attemptsLeft: Schema.Finite,
  lastAttemptTime: Schema.Finite,
});

const decodeBudget = Schema.decodeUnknownSync(Schema.fromJsonString(Budget));

/** The unlock-code tries `userId` has left, as the core last stored them. */
const budgetOf = (userId: string) =>
  newestRows("rateLimits", 1000)
    .map((row) => decodeBudget(row))
    .find((budget) => budget.identifier === `unlock:${userId}`);

describe.skipIf(stack === undefined)("refunding a right unlock code", { timeout: 120_000 }, () => {
  it("leaves alone a code that replaced the one the action checked, and its strikes", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await member(stack, "refund");
    const tv = await sharedDevice(stack, admin, "Refund TV");

    await dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code: "2468" });
    const checked = codeIdOf(dad.userId);

    await dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code: "1357" });
    const replacement = codeIdOf(dad.userId);

    expect(replacement).not.toBe(checked);

    importRows("unlockStrikes", [
      { deviceId: tv.deviceId, userId: dad.userId, codeId: replacement, wrong: 5 },
    ]);
    const budgetBefore = budgetOf(dad.userId);

    const refunded = await runFunction(
      stack,
      internal.core.devices.unlockCodes.refundRightCode,
      { deviceId: tv.deviceId, by: dad.userId, codeId: checked },
      Schema.Boolean,
    );

    expect(refunded).toBe(false);
    expect(strikesOf(tv.deviceId, dad.userId)).toMatchObject({ codeId: replacement, wrong: 5 });
    expect(budgetOf(dad.userId)).toEqual(budgetBefore);

    expect(
      await runFunction(
        stack,
        internal.core.devices.unlockCodes.refundRightCode,
        { deviceId: tv.deviceId, by: dad.userId, codeId: replacement },
        Schema.Boolean,
      ),
    ).toBe(true);
    expect(strikesOf(tv.deviceId, dad.userId)).toBeUndefined();
  });
});
