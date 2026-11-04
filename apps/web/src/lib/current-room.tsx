import type { DeviceId, EpisodeId, ProfileId, RoomId, TitleId } from "@media/contracts/ids";
import { useCommandQuery, useRoomPresence } from "@media/sdk/react";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { useActiveProfile } from "@/session/guards";

import { loadDeviceId } from "./device-storage";

/** The room this device is in, reduced to what the pill and the menu show. */
export interface CurrentRoom {
  readonly id: RoomId;
  readonly titleId: TitleId;
  readonly titleName: string;
  /** The episode the room plays, for shows. */
  readonly episodeId: EpisodeId | null;
  /** How many are in the room, away members included. */
  readonly members: number;
  /**
   * Whether the device is in the room with the active profile. Only then is the room shown,
   * offered to return to, or kept with heartbeats; another profile can only leave it.
   */
  readonly mine: boolean;
  /** Whether the device hosts the room, so leaving it ends it for everyone. */
  readonly hosting: boolean;
  /**
   * Whether returning lands in a live room: false for a guest while its host is away, when the
   * server has paused it until the host comes back and the player would only say the host left.
   * The host may always return.
   */
  readonly returnable: boolean;
}

const useDeviceRoom = (
  deviceId: DeviceId,
  profileId: ProfileId,
  enabled: boolean,
): CurrentRoom | null => {
  const current = useCommandQuery("rooms.current", enabled ? { deviceId } : "skip");
  const room = current.status === "success" ? current.data : null;
  const self = room?.members.find((member) => member.deviceId === deviceId);
  const id = room?.id ?? null;
  const titleId = room?.title.id ?? null;
  const titleName = room?.title.name ?? "";
  const episodeId = room?.episode?.id ?? null;
  const members = room?.members.length ?? 0;
  const mine = self !== undefined && self.profileId === profileId;
  const hosting = self?.role === "host";
  const returnable = room !== null && (!room.hostAway || self?.role === "host");

  return useMemo(
    () =>
      id === null || titleId === null
        ? null
        : { id, titleId, titleName, episodeId, members, mine, hosting, returnable },
    [id, titleId, titleName, episodeId, members, mine, hosting, returnable],
  );
};

const CurrentRoomContext = createContext<CurrentRoom | null>(null);

/**
 * Reads this device's room for everything inside, and keeps the device's place in it with
 * heartbeats that say it is away while the room is the active profile's. `keepPlace` is false
 * where the room's own player runs, which follows its room and sends this device's heartbeats
 * itself: the provider then reads nothing and provides null. Must sit inside
 * `RequireProfile`. Only this component re-renders as members' heartbeats change the record.
 */
export function CurrentRoomProvider({
  keepPlace = true,
  children,
}: {
  readonly keepPlace?: boolean;
  readonly children: ReactNode;
}) {
  const { profile } = useActiveProfile();
  const deviceId = useMemo(() => loadDeviceId(), []);
  const room = useDeviceRoom(deviceId, profile.id, keepPlace);

  useRoomPresence(room?.mine === true ? { roomId: room.id, deviceId } : null);

  return <CurrentRoomContext value={room}>{children}</CurrentRoomContext>;
}

/** This device's room inside `CurrentRoomProvider`; null without one, and elsewhere. */
export const useCurrentRoom = (): CurrentRoom | null => useContext(CurrentRoomContext);

/** A link into the player for a room, as the router takes it. */
export interface ReturnTarget {
  readonly to: "/watch/$titleId";
  readonly params: { readonly titleId: TitleId };
  readonly search: { readonly room: RoomId; readonly episodeId?: EpisodeId };
}

/**
 * Where returning to a room goes: the player on what the room plays now, joined to it. Built from
 * the live record, so a room that moved to another episode or title while the viewer browsed opens
 * on the new one.
 */
export const returnTarget = (room: {
  readonly id: RoomId;
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
}): ReturnTarget => ({
  to: "/watch/$titleId",
  params: { titleId: room.titleId },
  search:
    room.episodeId === null ? { room: room.id } : { room: room.id, episodeId: room.episodeId },
});
