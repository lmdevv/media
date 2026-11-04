import type { DeviceId, ProfileId, RoomId } from "@media/contracts/ids";
import type { Room } from "@media/contracts/models/rooms";
import { HEARTBEAT_INTERVAL_MS } from "@media/contracts/clock";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Predicate } from "effect";
import { useEffect, useState } from "react";

import type { RoomDenial } from "./room-states";

type RoomJoin =
  | { readonly status: "joining" }
  | { readonly status: "joined" }
  | { readonly status: "denied"; readonly denial: RoomDenial };

/** A room the player is in, or is joining. */
export interface WatchRoom {
  readonly join: RoomJoin;
  /** The room's record, once read. */
  readonly room: Room | null;
}

/**
 * Joins `roomId` with `profileId` on `deviceId` and follows the room. A room the profile cannot
 * see, or that ended before joining, comes back denied; null without a room.
 */
export const useWatchRoom = (
  roomId: RoomId | null,
  profileId: ProfileId,
  deviceId: DeviceId,
): WatchRoom | null => {
  const joinRoom = useCommand("rooms.join");
  const [join, setJoin] = useState<RoomJoin>({ status: "joining" });
  const record = useCommandQuery("rooms.get", roomId === null ? "skip" : { roomId, profileId });
  const room = record.status === "success" ? record.data : null;

  const outOfReach =
    record.status === "error" &&
    Predicate.isTagged(record.error, "NotFound") &&
    join.status === "joined";

  const retry = outOfReach ? record.retry : null;

  useEffect(() => {
    if (retry === null) return undefined;

    const timer = setInterval(retry, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [retry]);

  useEffect(() => {
    if (roomId === null) return undefined;

    let active = true;

    setJoin({ status: "joining" });
    joinRoom({ roomId, profileId, deviceId }).then(
      () => {
        if (active) setJoin({ status: "joined" });

        return undefined;
      },
      (cause: unknown) => {
        if (!active) return;

        setJoin({
          status: "denied",
          denial: Predicate.isTagged(cause, "Conflict")
            ? { kind: "ended", hostName: "The host" }
            : { kind: "household", hostName: null },
        });
      },
    );

    return () => {
      active = false;
    };
  }, [joinRoom, roomId, profileId, deviceId]);

  if (roomId === null) return null;

  if (record.status === "error" && Predicate.isTagged(record.error, "Conflict")) {
    return {
      join: { status: "denied", denial: { kind: "ended", hostName: "The host" } },
      room: null,
    };
  }

  if (record.status === "error" && Predicate.isTagged(record.error, "NotFound")) {
    return {
      join: {
        status: "denied",
        denial: outOfReach
          ? { kind: "unavailable", hostName: null }
          : { kind: "household", hostName: null },
      },
      room: null,
    };
  }

  const named = (denial: RoomDenial): RoomDenial =>
    room === null || denial.kind === "unavailable"
      ? denial
      : { ...denial, hostName: room.hostProfileName };

  return {
    join: join.status === "denied" ? { status: "denied", denial: named(join.denial) } : join,
    room,
  };
};
