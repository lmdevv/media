import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import type { DeviceResource, PersonDoc } from "../permissions/policy";
import { boundDevice, liveOnDevice, liveSession } from "../sessions";
import type { Player, Request } from "./playback";

const SESSIONS_READ = 8;

/** The device's player row, or null before its first report. */
export const playerOf = (db: DatabaseReader, deviceId: Id<"devices">): Promise<Player | null> =>
  db
    .query("connectPlayers")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();

/** The newest request made of the device, or null before the first. */
export const requestOf = (db: DatabaseReader, deviceId: Id<"devices">): Promise<Request | null> =>
  db
    .query("connectRequests")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();

/** Forgets what Connect kept for a device: its report and its request. */
export const dropConnect = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
): Promise<void> => {
  const rows: ReadonlyArray<Doc<"connectPlayers"> | Doc<"connectRequests"> | null> =
    await Promise.all([playerOf(ctx.db, deviceId), requestOf(ctx.db, deviceId)]);

  await Promise.all(rows.flatMap((row) => (row === null ? [] : [ctx.db.delete(row._id)])));
};

const signedInHere = async (
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

/** `device` as `can` sees it for `person` while it plays `domain`. */
export const deviceFor = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  person: PersonDoc,
  domain: ContentDomain | null,
  now: number,
): Promise<DeviceResource> => ({
  on: "device",
  relation:
    device.mode === "personal"
      ? { mode: "personal", signedInHere: await signedInHere(db, device, person, now) }
      : { mode: "shared", listed: person.sharedDevices === true },
  domain,
  // No device plays a group session until group sessions exist (ADR 0017).
  session: null,
});

/** Whether the session that reported is still live and still on the device. */
export const reporting = async (
  db: DatabaseReader,
  player: Player,
  now: number,
): Promise<boolean> => {
  const live = await liveSession(db, player.reporter, now);

  return live !== null && boundDevice(live.session)?.id === player.deviceId;
};
