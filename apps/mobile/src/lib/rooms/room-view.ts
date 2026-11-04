import { DRIFT_THRESHOLDS } from "@media/contracts/clock";
import type { DeviceId, ProfileId, RoomId } from "@media/contracts/ids";
import type { Room, RoomMember } from "@media/contracts/models/rooms";
import { Predicate } from "effect";
import { sortedBy } from "../sorted-by";

/** This device's part in a room. */
export type RoomRole = "host" | "guest";

/**
 * The web app's invite link for `roomId` on the media service at `mediaUrl`, which also serves the
 * web app: `<server>/r/<roomId>`, as the web player copies it.
 */
export const roomLink = (mediaUrl: string, roomId: RoomId): string =>
  `${mediaUrl.trim().replace(/\/+$/u, "")}/r/${encodeURIComponent(roomId)}`;

/** A link as the invite popup shows it, without its scheme: `cinema.home/r/7K4P2`. */
export const shownLink = (link: string): string => link.replace(/^[a-z][a-z\d+.-]*:\/\//iu, "");

/** The Messages compose URL with `link` as the message. */
export const messagesUrl = (link: string): string => `sms:&body=${encodeURIComponent(link)}`;

/** `3 Watching`: everyone in the room, members browsing elsewhere in the app included. */
export const watchingLabel = (count: number): string => `${String(count)} Watching`;

/** The person a member row stands for. */
export interface MemberRow {
  readonly id: DeviceId;
  readonly name: string;
  /** The profile's avatar key; null for a host who has left, whose avatar the room no longer has. */
  readonly avatar: string | null;
  /** `You · Host`, `You`, `Host`, `Away`, `Host · Left`, or nothing. */
  readonly detail: string | null;
}

const memberDetail = (member: RoomMember, self: boolean): string | null => {
  const host = member.role === "host";
  const away = member.presence === "away" && !self;
  const parts = [self ? "You" : null, host ? "Host" : null, away ? "Away" : null];
  const shown = parts.filter((part) => part !== null);

  return shown.length === 0 ? null : shown.join(" · ");
};

/**
 * The rows of `room`'s people as `deviceId` sees them: this device first, then the host, then the
 * other guests in the order they joined. A host who left keeps a row, so guests know who it was.
 */
export const memberRows = (
  room: Pick<Room, "members" | "hostDeviceId" | "hostProfileName">,
  deviceId: DeviceId,
): ReadonlyArray<MemberRow> => {
  const rank = (member: RoomMember): number =>
    member.deviceId === deviceId ? 0 : member.role === "host" ? 1 : 2;

  const rows = sortedBy(
    room.members,
    (left, right) => rank(left) - rank(right) || left.joinedAt - right.joinedAt,
  ).map((member): MemberRow => ({
    id: member.deviceId,
    name: member.profileName,
    avatar: member.avatar,
    detail: memberDetail(member, member.deviceId === deviceId),
  }));

  if (room.members.some((member) => member.role === "host")) return rows;

  const left: MemberRow = {
    id: room.hostDeviceId,
    name: room.hostProfileName,
    avatar: null,
    detail: "Host · Left",
  };

  const [first, ...rest] = rows;

  return first?.id === deviceId ? [first, left, ...rest] : [left, ...rows];
};

/** A line about the shared timeline under a room's heading. */
export interface RoomNotice {
  readonly text: string;
  /** Shows the spinner beside it: everyone waits for the host. */
  readonly waiting: boolean;
}

/**
 * What a member should know about the shared timeline, or null when it simply plays: a guest waits
 * while the host buffers, sees that the host paused, and that the host left. The host knows what
 * it did.
 */
export const roomNotice = (
  room: Pick<Room, "clock" | "hostProfileName" | "hostAway">,
  role: RoomRole,
): RoomNotice | null => {
  if (role === "host" || room.clock.status === "ended") return null;

  const host = room.hostProfileName;

  if (room.hostAway) return { text: `${host} left the room.`, waiting: false };

  if (room.clock.status === "buffering") return { text: `Waiting for ${host}…`, waiting: true };

  if (room.clock.status === "paused") return { text: `${host} paused playback.`, waiting: false };

  return null;
};

/** The parts of a query's state `roomAccess` reads, as `useCommandQuery` returns them. */
export type RoomRead =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: Room }
  | { readonly status: "error"; readonly error: unknown };

/** Where this device stands with a room it opened. */
export type RoomAccess =
  | { readonly kind: "loading" }
  /** Not in the room yet: it can join. */
  | { readonly kind: "join"; readonly room: Room }
  /** In the room with this profile. */
  | { readonly kind: "member"; readonly room: Room; readonly role: RoomRole }
  /** A guest whose host went quiet: the server paused the room until the host returns. */
  | { readonly kind: "hostLeft"; readonly room: Room }
  | { readonly kind: "ended" }
  /** The room is gone, or this profile may not watch what it plays. */
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Where `deviceId`, on `profileId`, stands with the room `read` returned. A device in the room with
 * another profile has not joined with this one, so it may join again; joining switches its profile.
 * `rooms.get` answers `not_found` for a room this profile may not watch, so the reply never tells
 * whether it exists, and `conflict` for a member's room that ended out of its reach.
 */
export const roomAccess = (
  read: RoomRead,
  deviceId: DeviceId,
  profileId: ProfileId,
): RoomAccess => {
  if (read.status === "loading") return { kind: "loading" };

  if (read.status === "error") {
    if (Predicate.isTagged(read.error, "NotFound")) return { kind: "denied" };

    return Predicate.isTagged(read.error, "Conflict")
      ? { kind: "ended" }
      : { kind: "failed", error: read.error };
  }

  const room = read.data;

  if (room.clock.status === "ended") return { kind: "ended" };

  const self = room.members.find(
    (member) => member.deviceId === deviceId && member.profileId === profileId,
  );

  if (self === undefined) return { kind: "join", room };

  const role: RoomRole = room.hostDeviceId === deviceId ? "host" : "guest";

  return role === "guest" && room.hostAway
    ? { kind: "hostLeft", room }
    : { kind: "member", room, role };
};

/** What `guestCatchingUp` reads of the room engine's state. */
export interface GuestSync {
  readonly offset: unknown;
  readonly follow: "following" | "buffering" | "detached" | "blocked" | "moved" | "ended";
  readonly clockStatus: Room["clock"]["status"];
  readonly driftMs: number | null;
}

/**
 * Whether a guest's player is still catching up with the room: the engine has not started or read
 * the server clock, or the room plays while this player stalls or sits further off than a seek
 * corrects. Null stands for an engine that has not started.
 */
export const guestCatchingUp = (sync: GuestSync | null): boolean =>
  sync === null ||
  sync.offset === null ||
  sync.follow === "blocked" ||
  (sync.clockStatus === "playing" &&
    (sync.follow === "buffering" ||
      sync.driftMs === null ||
      Math.abs(sync.driftMs) >= DRIFT_THRESHOLDS.seekMs));
