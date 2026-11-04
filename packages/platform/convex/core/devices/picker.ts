import { register } from "../../../commands/core/devices/picker";
import { fail } from "../lib/errors";
import { isKid, lockOf } from "../permissions/policy";
import type { Lock, PersonDoc } from "../permissions/policy";
import { currentApproval } from "./approvals";
import { LISTED_MAX, NO_DEVICE, deviceOfCode, holderOf, listedPeople, tileOf } from "./facts";
import { signedInOn } from "./registry";
import { codeOf, codeState } from "./unlockCodes";

const lockView = (lock: Lock) =>
  lock.state === "open"
    ? { state: "open" as const }
    : { state: "locked" as const, because: [...lock.because], opensWith: lock.opensWith };

const byUsername = (left: PersonDoc, right: PersonDoc): number =>
  left.usernameKey < right.usernameKey ? -1 : Number(left.usernameKey > right.usernameKey);

export const { show } = register({
  show: async (ctx, { device: code }) => {
    const device = (await deviceOfCode(ctx.db, code)) ?? fail("not_found", NO_DEVICE);
    const now = Date.now();

    if (device.mode === "personal") {
      const people = new Map(
        (await signedInOn(ctx.db, device._id, now)).map(({ person }) => [person._id, person]),
      );

      return {
        deviceId: device._id,
        name: device.name,
        mode: device.mode,
        tiles: [...people.values()]
          .toSorted(byUsername)
          .map((person) => ({ userId: person._id, username: person.username })),
      };
    }

    const listed = await listedPeople(ctx.db);
    const holder = holderOf(device, listed);

    const [codes, strikes, approval] = await Promise.all([
      Promise.all(listed.map((person) => codeOf(ctx.db, person._id))),
      ctx.db
        .query("unlockStrikes")
        .withIndex("by_device_user", (q) => q.eq("deviceId", device._id))
        .take(LISTED_MAX * 2),
      currentApproval(ctx.db, device._id, now),
    ]);

    return {
      deviceId: device._id,
      name: device.name,
      mode: device.mode,
      holder,
      tiles: listed.map((person, index) => ({
        userId: person._id,
        username: person.username,
        kid: isKid(person),
        code: codeState(
          codes[index] ?? null,
          strikes.find((strike) => strike.userId === person._id) ?? null,
        ),
        lock: lockView(lockOf(tileOf(person, listed, holder, null))),
      })),
      approval:
        approval === null
          ? null
          : {
              approvalId: approval._id,
              intent: approval.intent,
              userId: approval.userId,
              state: approval.state,
              expiresAt: approval.expiresAt,
            },
    };
  },
});
