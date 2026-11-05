import { register } from "../../../commands/core/connect/targets";
import type { Doc } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { callerUser } from "../auth/caller";
import { NO_DEVICE } from "../devices/facts";
import { fail } from "../lib/errors";
import { can } from "../permissions/policy";
import type { DeviceResource, PersonDoc, Principal } from "../permissions/policy";
import { liveOnDevice } from "../sessions";
import { ONLINE_MS, changed, nextRevision, parsePosition, playbackOf } from "./playback";
import type { Change, Player } from "./playback";
import { playerOf, requestOf } from "./player";

const TARGETS_READ = 100;

const SESSIONS_READ = 8;

const signedInOn = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  person: PersonDoc,
  now: number,
): Promise<boolean> => {
  const sessions = await db
    .query("authSessions")
    .withIndex("by_device_user", (q) => q.eq("device.id", device._id).eq("userId", person._id))
    .take(SESSIONS_READ);

  return sessions.some((session) => liveOnDevice(session, person, device, now));
};

const deviceFor = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  person: PersonDoc,
  player: Player | null,
  now: number,
): Promise<DeviceResource> => ({
  on: "device",
  relation:
    device.mode === "personal"
      ? { mode: "personal", signedInHere: await signedInOn(db, device, person, now) }
      : { mode: "shared", listed: person.sharedDevices === true },
  domain: player?.playback?.domain ?? null,
  // No device plays a group session until group sessions exist (ADR 0017).
  session: null,
});

const reporting = async (
  db: DatabaseReader,
  player: Player,
  device: Doc<"devices">,
  now: number,
): Promise<boolean> => {
  const session = await db.get(player.reporter);
  const user = session === null ? null : await db.get(session.userId);

  return session !== null && user !== null && liveOnDevice(session, user, device, now);
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

    const players = await ctx.db
      .query("connectPlayers")
      .withIndex("by_reported", (q) => q.gt("reportedAt", now - ONLINE_MS))
      .order("desc")
      .take(TARGETS_READ);

    const targets = await Promise.all(
      players.map(async (player) => {
        const device = await ctx.db.get(player.deviceId);

        if (device === null || !(await reporting(ctx.db, player, device, now))) return [];

        const resource = await deviceFor(ctx.db, device, person, player, now);

        if (!can(caller, "control", resource).allowed) return [];

        return [
          {
            deviceId: device._id,
            name: device.name,
            mode: device.mode,
            output: player.output,
            playback: playbackOf(player, await requestOf(ctx.db, device._id)),
            reportedAt: player.reportedAt,
          },
        ];
      }),
    );

    return targets.flat();
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

    requireControl(caller, await deviceFor(ctx.db, device, person, player, now));

    const online =
      player !== null &&
      now - player.reportedAt <= ONLINE_MS &&
      (await reporting(ctx.db, player, device, now));

    if (!online) return fail("conflict", "That device is offline");

    const current = playbackOf(player, request) ?? fail("conflict", "Nothing plays on that device");
    const revision = nextRevision(player, request);

    const row = { deviceId, reporter: player.reporter, revision, ...changed(current, change, now) };

    if (request === null) await ctx.db.insert("connectRequests", row);
    else await ctx.db.replace(request._id, row);

    return { revision };
  },
});
