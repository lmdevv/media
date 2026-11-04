import type { DeviceId } from "@media/contracts/ids";
import type { Room } from "@media/contracts/models/rooms";
import type { RoomMember, RoomMemberStatus } from "@media/ui/components/room-panel";

import { avatarImage } from "@/lib/avatars";

const SHOWN_DRIFT_MS = 1_000;

/** `-2.4s` or `+1.2s`. */
export const driftLabel = (driftMs: number): string =>
  `${driftMs < 0 ? "-" : "+"}${(Math.abs(driftMs) / 1000).toFixed(1)}s`;

/** Whether the room is paused because its host went quiet or left. */
export const hostGone = (room: Pick<Room, "hostAway" | "clock">): boolean =>
  room.hostAway || room.clock.status === "ended";

const hostStatus = (
  room: Room,
  member: Room["members"][number],
  self: boolean,
): RoomMemberStatus | undefined => {
  if (hostGone(room)) return { kind: "left" };

  if (room.clock.status === "buffering") return { kind: "buffering" };

  return member.presence === "away" && !self ? { kind: "away" } : undefined;
};

const guestStatus = (
  member: Room["members"][number],
  self: boolean,
  syncing: boolean,
  ownDriftMs: number | null,
): RoomMemberStatus | undefined => {
  if (member.presence === "away" && !self) return { kind: "away" };

  if (self && syncing) return { kind: "syncing" };

  const drift = self ? ownDriftMs : member.driftMs;

  return drift !== null && Math.abs(drift) > SHOWN_DRIFT_MS
    ? { kind: "drift", label: driftLabel(drift) }
    : undefined;
};

/**
 * The panel rows for `room` as seen from `deviceId`. `syncing` marks this device still catching
 * up; `ownDriftMs` is its latest measured drift, fresher than what the server last heard.
 */
export const roomMembers = (
  room: Room,
  deviceId: DeviceId,
  syncing: boolean,
  ownDriftMs: number | null,
): ReadonlyArray<RoomMember> => {
  const rank = (member: Room["members"][number]): number =>
    member.role === "host" ? 0 : member.deviceId === deviceId ? 1 : 2;

  const members = room.members.toSorted(
    (left, right) => rank(left) - rank(right) || left.joinedAt - right.joinedAt,
  );

  const rows = members.map((member): RoomMember => {
    const self = member.deviceId === deviceId;
    const host = member.role === "host";

    return {
      id: member.deviceId,
      name: member.profileName,
      detail: host ? "Host" : self ? "You" : undefined,
      avatar: avatarImage(member.avatar),
      status: host
        ? hostStatus(room, member, self)
        : guestStatus(member, self, syncing, ownDriftMs),
    };
  });

  const hostListed = room.members.some((member) => member.role === "host");

  return hostListed
    ? rows
    : [
        {
          id: room.hostDeviceId,
          name: room.hostProfileName,
          detail: "Host",
          avatar: undefined,
          status: { kind: "left" },
        },
        ...rows,
      ];
};
