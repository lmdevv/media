import { RoomId } from "@media/contracts/ids";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { useCommand } from "@media/sdk/react";
import { LinkIcon, LogOutIcon, SquareXIcon, UsersIcon } from "lucide-react";
import { Option, Schema } from "effect";
import { useMemo } from "react";

import { returnTarget, useCurrentRoom } from "@/lib/current-room";
import { loadDeviceId } from "@/lib/device-storage";
import { toastFailure } from "@/lib/failure";

import type { CommandContext, CommandContribution } from "./contribution";

const decodeRoomId = Schema.decodeUnknownOption(RoomId);

const typedRoomId = (query: string): Option.Option<RoomId> => {
  const match = /\/r\/([a-z0-9]{16,})\/?$/iu.exec(query.trim());

  return match?.[1] === undefined ? Option.none() : decodeRoomId(match[1]);
};

/** Room actions for the menu. */
export const useRoomCommands = (context: CommandContext): CommandContribution => {
  const { navigate, query, player } = context;
  const deviceId = useMemo(() => loadDeviceId(), []);
  const leave = useCommand("rooms.leave");

  const shellRoom = useCurrentRoom();
  const current = player === null ? shellRoom : null;

  return useMemo((): CommandContribution => {
    const typed = typedRoomId(query);

    const join: ReadonlyArray<CommandItem> = Option.match(typed, {
      onNone: () => [],
      onSome: (roomId) => [
        {
          kind: "action",
          id: `room:join:${roomId}`,
          title: "Join room",
          leading: { kind: "icon", icon: UsersIcon },
          perform: () => navigate({ to: "/r/$roomId", params: { roomId } }),
        },
      ],
    });

    if (player !== null) {
      const inPlayer: ReadonlyArray<CommandItem> =
        player.room === null
          ? player.startRoom === null
            ? []
            : [
                {
                  kind: "action",
                  id: "room:start",
                  title: "Watch together",
                  keywords: ["room", "party", "invite", "start"],
                  leading: { kind: "icon", icon: UsersIcon },
                  perform: player.startRoom,
                },
              ]
          : [
              {
                kind: "action",
                id: "room:copy",
                title: "Copy room link",
                keywords: ["invite", "share"],
                leading: { kind: "icon", icon: LinkIcon },
                perform: player.room.copyLink,
              },
              player.room.role === "host"
                ? {
                    kind: "action",
                    id: "room:end",
                    title: "End room",
                    keywords: ["close", "stop"],
                    leading: { kind: "icon", icon: SquareXIcon },
                    perform: player.room.end,
                  }
                : {
                    kind: "action",
                    id: "room:leave",
                    title: "Leave room",
                    leading: { kind: "icon", icon: LogOutIcon },
                    perform: player.room.leave,
                  },
            ];

      return { groups: [{ id: "room", label: "Room", items: inPlayer }], fallback: join };
    }

    const back: ReadonlyArray<CommandItem> =
      current?.mine !== true || !current.returnable
        ? []
        : [
            {
              kind: "action",
              id: "room:return",
              title: "Return to room",
              detail: current.titleName,
              leading: { kind: "icon", icon: UsersIcon },
              perform: () => navigate(returnTarget(current)),
            },
          ];

    const elsewhere: ReadonlyArray<CommandItem> =
      current === null
        ? []
        : [
            ...back,
            {
              kind: "action",
              id: current.hosting ? "room:end" : "room:leave",
              title: current.hosting ? "End room" : "Leave room",
              keywords: ["leave", "close", "stop"],
              detail: current.mine ? current.titleName : undefined,
              leading: { kind: "icon", icon: current.hosting ? SquareXIcon : LogOutIcon },
              perform: () =>
                leave({ roomId: current.id, deviceId }).then(() => undefined, toastFailure),
            },
          ];

    return { groups: [{ id: "room", label: "Room", items: elsewhere }], fallback: join };
  }, [navigate, query, player, current, leave, deviceId]);
};
