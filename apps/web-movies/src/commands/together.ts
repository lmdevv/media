import { usePlatform } from "@media/sdk/react";
import { toastFailure } from "@media/ui/lib/failure";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { LinkIcon, LogOutIcon, SquareXIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";

import { useCurrentSession } from "@/together/current-session";
import { MOVIES, parseSessionLink } from "@/together/session";

import type { CommandContext, CommandContribution, PlayerTogether } from "./contribution";

const inPlayer = (together: PlayerTogether): ReadonlyArray<CommandItem> => {
  if (together.start !== null) {
    return [
      {
        kind: "action",
        id: "session:start",
        title: "Watch together",
        keywords: ["session", "party", "invite", "start", "room"],
        leading: { kind: "icon", icon: UsersIcon },
        perform: together.start,
      },
    ];
  }

  return [
    ...(together.copyLink === null
      ? []
      : [
          {
            kind: "action" as const,
            id: "session:copy",
            title: "Copy session link",
            keywords: ["invite", "share"],
            leading: { kind: "icon" as const, icon: LinkIcon },
            perform: together.copyLink,
          },
        ]),
    ...(together.leave === null
      ? []
      : [
          {
            kind: "action" as const,
            id: together.hosting ? "session:end" : "session:leave",
            title: together.hosting ? "End session" : "Leave session",
            keywords: ["close", "stop", "leave"],
            leading: { kind: "icon" as const, icon: together.hosting ? SquareXIcon : LogOutIcon },
            perform: together.leave,
          },
        ]),
  ];
};

/**
 * Watch together in the menu: in the player, start a session or copy and leave the one it plays;
 * elsewhere, return to the person's session or leave it. A pasted session link offers to join.
 */
export const useTogetherCommands = (context: CommandContext): CommandContribution => {
  const { navigate, query, player } = context;
  const platform = usePlatform();
  const view = useCurrentSession();
  const joined = view?.state === "joined" ? view : null;
  const waiting = view?.state === "pending";
  const hosting = joined?.role === "host";

  return useMemo((): CommandContribution => {
    const link = parseSessionLink(query);

    const join: ReadonlyArray<CommandItem> =
      link === null
        ? []
        : [
            {
              kind: "action",
              id: "session:join",
              title: "Join session",
              leading: { kind: "icon", icon: UsersIcon },
              perform: () => navigate({ to: "/together", hash: link }),
            },
          ];

    if (player !== null) {
      return {
        groups: [{ id: "session", label: "Watch together", items: inPlayer(player.together) }],
        fallback: join,
      };
    }

    const leave = (): void => {
      void platform.core.together.leave({ domain: MOVIES }).catch(toastFailure);
    };

    const elsewhere: ReadonlyArray<CommandItem> =
      joined === null && !waiting
        ? []
        : [
            {
              kind: "action",
              id: "session:return",
              title: waiting ? "Show the session you asked to join" : "Return to session",
              leading: { kind: "icon", icon: UsersIcon },
              perform: () => navigate({ to: "/together" }),
            },
            {
              kind: "action",
              id: hosting ? "session:end" : "session:leave",
              title: hosting ? "End session" : "Leave session",
              keywords: ["leave", "close", "stop"],
              leading: { kind: "icon", icon: hosting ? SquareXIcon : LogOutIcon },
              perform: leave,
            },
          ];

    return {
      groups: [{ id: "session", label: "Watch together", items: elsewhere }],
      fallback: join,
    };
  }, [navigate, query, player, platform, joined, waiting, hosting]);
};
