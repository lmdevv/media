import type { CommandItem } from "@media/ui/lib/command-menu";
import { UserRoundIcon, UsersRoundIcon } from "lucide-react";
import { useMemo } from "react";

import { avatarImage } from "@/lib/avatars";
import { keymap } from "@/lib/keymap";
import { useProfileChoice } from "@/session/profile-choice";

import type { CommandContext, CommandContribution } from "./contribution";

/** The id of the "Switch profile" submenu, which `mod+shift+p` opens directly. */
export const SWITCH_PROFILE_COMMAND = "switch-profile";

/**
 * "Switch profile": the account's other profiles. A PIN profile asks for its PIN first; the new
 * profile opens on Home, since what the old one was looking at may be hidden from it.
 */
export const useProfileCommands = (context: CommandContext): CommandContribution => {
  const { navigate, profile, profiles } = context;
  const { choose } = useProfileChoice();

  return useMemo((): CommandContribution => {
    const options = profiles.map((candidate): CommandItem => {
      const image = avatarImage(candidate.avatar);

      return {
        kind: "action",
        id: `profile:${candidate.id}`,
        title: candidate.name,
        detail: candidate.kids ? "Kids" : undefined,
        leading:
          image === undefined
            ? { kind: "icon", icon: UserRoundIcon }
            : { kind: "poster", src: image },
        checked: candidate.id === profile.id,
        perform: () => {
          if (candidate.id === profile.id) return;

          if (candidate.locked) {
            void navigate({
              to: "/profiles/$profileId/pin",
              params: { profileId: candidate.id },
              search: { redirect: "/" },
            });

            return;
          }

          choose(candidate.id);
          void navigate({ to: "/" });
        },
      };
    });

    const manage: CommandItem = {
      kind: "action",
      id: "profiles:manage",
      title: "Manage profiles",
      leading: { kind: "icon", icon: UsersRoundIcon },
      perform: () => navigate({ to: "/profiles" }),
    };

    return {
      groups: [
        {
          id: "actions",
          label: "Actions",
          items: [
            {
              kind: "submenu",
              id: SWITCH_PROFILE_COMMAND,
              title: "Switch profile",
              detail: profile.name,
              keywords: ["profile", "who", "account"],
              leading: { kind: "icon", icon: UserRoundIcon },
              keycaps: keymap.keycaps("profile.switch"),
              page: {
                id: SWITCH_PROFILE_COMMAND,
                breadcrumb: "Switch profile",
                placeholder: "Profile…",
                groups: [{ id: "profiles", items: [...options, manage] }],
              },
            },
          ],
        },
      ],
    };
  }, [navigate, profile, profiles, choose]);
};
