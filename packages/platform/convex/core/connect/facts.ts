import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { heldScopes, principalOf } from "../permissions/policy";
import type {
  DeviceRelation,
  DeviceResource,
  DeviceSession,
  PersonDoc,
  Principal,
} from "../permissions/policy";
import { boundDevice, liveOnDevice, liveSession } from "../sessions";
import { memberIn, placeOf } from "../together/access";
import { isOnline } from "./playback";
import type { Playback, Player, Request } from "./playback";

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

const relationTo = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  person: PersonDoc,
  now: number,
): Promise<DeviceRelation> =>
  device.mode === "personal"
    ? { mode: "personal", signedInHere: await signedInHere(db, device, person, now) }
    : { mode: "shared", listed: person.sharedDevices === true };

/**
 * The person whose session reports for the device, as a principal holding that session's scopes,
 * or null when none reports for it now.
 */
export const reporterOf = async (
  db: DatabaseReader,
  player: Player,
  now: number,
): Promise<Principal | null> => {
  if (!isOnline(player, now)) return null;

  const live = await liveSession(db, player.reporter, now);

  if (live === null || boundDevice(live.session)?.id !== player.deviceId) return null;

  const principal = principalOf(live.user, heldScopes(live.session, live.user));

  return principal.kind === "person" ? { ...principal, sessionKind: live.session.kind } : null;
};

/** A device's player row and what it plays as controllers see it. */
export interface Playing {
  readonly player: Player | null;
  readonly current: Playback | null;
}

/**
 * The session the report names, while the report still says what plays: a pending load or stop
 * replaces the session's item on the device.
 */
const sessionFor = async (
  db: DatabaseReader,
  { player, current }: Playing,
  person: PersonDoc,
): Promise<DeviceSession | null> => {
  const reported = player?.playback ?? null;
  const sessionId = reported?.session;

  if (player === null || reported === null || sessionId === undefined) return null;

  if (current === null || current.loading !== null) return null;

  const { domain } = reported.item;

  const [session, reporting, own] = await Promise.all([
    db.get(sessionId),
    db.get(player.reporter),
    memberIn(db, person._id, domain),
  ]);

  if (session === null) return null;

  const reporterRow =
    reporting === null || reporting.userId === person._id
      ? own
      : await memberIn(db, reporting.userId, domain);

  const reporterIn =
    reporting === null ? "outside" : placeOf(session, reporting.userId, reporterRow);

  return {
    live: session.state === "live" && (reporterIn === "host" || reporterIn === "guest"),
    place: placeOf(session, person._id, own),
    settings: session.settings,
  };
};

/**
 * `device` as `can` sees it for `person` while it plays `domain`. Only a guest's decision reads the
 * group session (D35), so only a guest's reads it.
 */
export const deviceFor = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  person: PersonDoc,
  playing: Playing | null,
  domain: ContentDomain | null,
  now: number,
): Promise<DeviceResource> => {
  const [relation, session] = await Promise.all([
    relationTo(db, device, person, now),
    playing === null || person.role !== "guest" ? null : sessionFor(db, playing, person),
  ]);

  return { on: "device", relation, domain, session };
};
