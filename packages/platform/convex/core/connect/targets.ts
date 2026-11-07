import { register } from "../../../commands/core/connect/targets";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { callerUser } from "../auth/caller";
import { NO_DEVICE } from "../devices/facts";
import { fail } from "../lib/errors";
import { can } from "../permissions/policy";
import type { DeviceResource, PersonDoc, Principal } from "../permissions/policy";
import { boundDevice } from "../sessions";
import { deviceFor, playerOf, reporting, requestOf } from "./facts";
import { changed, isOnline, nextRevision, parsePosition, playbackOf } from "./playback";
import type { Change } from "./playback";

const BOUND_DEVICES_READ = 64;

const SHARED_DEVICES_READ = 64;

/**
 * Sessions bound to a device sort after those on none, so the descending walk ends at the first
 * session on no device.
 */
const boundBelow = async (
  db: DatabaseReader,
  userId: Id<"users">,
  below: Id<"devices"> | null,
  left: number,
): Promise<ReadonlyArray<Id<"devices">>> => {
  if (left === 0) return [];

  const session = await db
    .query("authSessions")
    .withIndex("by_user_device", (q) =>
      below === null ? q.eq("userId", userId) : q.eq("userId", userId).lt("device.id", below),
    )
    .order("desc")
    .first();

  const deviceId = session === null ? null : (boundDevice(session)?.id ?? null);

  return deviceId === null ? [] : [deviceId, ...(await boundBelow(db, userId, deviceId, left - 1))];
};

const reachable = async (
  db: DatabaseReader,
  person: PersonDoc,
): Promise<ReadonlyArray<Id<"devices">>> => {
  const bound = await boundBelow(db, person._id, null, BOUND_DEVICES_READ);

  const shared: ReadonlyArray<Doc<"devices">> =
    person.sharedDevices === true
      ? await db
          .query("devices")
          .withIndex("by_mode", (q) => q.eq("mode", "shared"))
          .take(SHARED_DEVICES_READ)
      : [];

  return [...new Set([...bound, ...shared.map((device) => device._id)])];
};

const requireControl = (principal: Principal, device: DeviceResource): void => {
  const decision = can(principal, "control", device);

  if (decision.allowed) return;

  if (decision.refusal === "hidden") fail("not_found", NO_DEVICE);

  fail(
    "forbidden",
    decision.because === "no-control"
      ? "The session's host has not let you control playback"
      : "This session cannot play what that device plays",
  );
};

const parseChange = ({ playing, positionMs }: Change): Change => {
  if (playing === undefined && positionMs === undefined) {
    return fail("invalid_args", "Say whether to play, where to seek, or both");
  }

  return { playing, positionMs: positionMs === undefined ? undefined : parsePosition(positionMs) };
};

export const { list, control } = register({
  list: async (ctx, _args, caller) => {
    const person = await callerUser(ctx, caller);
    const now = Date.now();

    const targets = await Promise.all(
      (await reachable(ctx.db, person)).map(async (deviceId) => {
        const [device, player] = await Promise.all([
          ctx.db.get(deviceId),
          playerOf(ctx.db, deviceId),
        ]);

        if (
          device === null ||
          player === null ||
          !isOnline(player, now) ||
          !(await reporting(ctx.db, player, now))
        ) {
          return [];
        }

        const resource = await deviceFor(
          ctx.db,
          device,
          person,
          player.playback?.domain ?? null,
          now,
        );

        if (!can(caller, "control", resource).allowed) return [];

        return [
          {
            deviceId,
            name: device.name,
            mode: device.mode,
            output: player.output,
            playback: playbackOf(player, await requestOf(ctx.db, deviceId)),
            reportedAt: player.reportedAt,
          },
        ];
      }),
    );

    return targets.flat().toSorted((left, right) => right.reportedAt - left.reportedAt);
  },
  control: async (ctx, { deviceId, ...asked }, caller) => {
    const change = parseChange(asked);
    const now = Date.now();
    const device = (await ctx.db.get(deviceId)) ?? fail("not_found", NO_DEVICE);

    const [person, player, request] = await Promise.all([
      callerUser(ctx, caller),
      playerOf(ctx.db, deviceId),
      requestOf(ctx.db, deviceId),
    ]);

    requireControl(
      caller,
      await deviceFor(ctx.db, device, person, player?.playback?.domain ?? null, now),
    );

    const online =
      player !== null && isOnline(player, now) && (await reporting(ctx.db, player, now));

    if (!online) return fail("conflict", "That device is offline");

    const current = playbackOf(player, request) ?? fail("conflict", "Nothing plays on that device");
    const revision = nextRevision(request);

    const row = { deviceId, reporter: player.reporter, revision, ...changed(current, change, now) };

    if (request === null) await ctx.db.insert("connectRequests", row);
    else await ctx.db.replace(request._id, row);

    return { revision };
  },
});
