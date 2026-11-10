import type { CommandItem } from "@media/ui/lib/command-menu";
import { LogOutIcon, MonitorIcon, UserRoundCogIcon, UsersRoundIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useMemo } from "react";

import { ACCOUNT_SETTINGS } from "@/lib/account-links";
import { useMe, useSignOut } from "@/session/session";

import type { CommandContribution } from "./contribution";

type ThemeChoice = "dark" | "light" | "system";

const THEMES: ReadonlyArray<{ readonly id: ThemeChoice; readonly title: string }> = [
  { id: "dark", title: "Dark" },
  { id: "light", title: "Light" },
  { id: "system", title: "Match system" },
];

/** The submenu the account button opens: who is signed in, and switching person. */
export const SWITCH_PERSON_COMMAND = "switch-person";

/**
 * This browser's preferences and the session: the theme, switching person, and signing out.
 * Switching person signs this person out so the next one signs in at `/` (D52).
 */
export const usePreferenceCommands = (): CommandContribution => {
  const { theme, setTheme } = useTheme();
  const signOut = useSignOut();
  const name = useMe()?.username ?? "";
  const current: ThemeChoice = theme === "dark" || theme === "light" ? theme : "system";

  return useMemo(
    (): CommandContribution => ({
      groups: [
        {
          id: "actions",
          label: "Actions",
          items: [
            {
              kind: "submenu",
              id: "theme",
              title: "Theme…",
              keywords: ["appearance", "dark", "light", "mode"],
              leading: { kind: "icon", icon: MonitorIcon },
              page: {
                id: "theme",
                breadcrumb: "Theme",
                placeholder: "Theme…",
                groups: [
                  {
                    id: "themes",
                    items: THEMES.map((choice): CommandItem => ({
                      kind: "action",
                      id: choice.id,
                      title: choice.title,
                      checked: choice.id === current,
                      perform: () => setTheme(choice.id),
                    })),
                  },
                ],
              },
            },
            {
              kind: "submenu",
              id: SWITCH_PERSON_COMMAND,
              title: "Switch person",
              detail: name,
              keywords: ["profile", "who", "account", "user"],
              leading: { kind: "icon", icon: UsersRoundIcon },
              page: {
                id: SWITCH_PERSON_COMMAND,
                breadcrumb: "Switch person",
                placeholder: "Switch person…",
                groups: [
                  {
                    id: "person",
                    items: [
                      {
                        kind: "action",
                        id: "switch-person:sign-out",
                        title: name === "" ? "Sign out" : `Sign out ${name}`,
                        keywords: ["switch", "log out"],
                        leading: { kind: "icon", icon: LogOutIcon },
                        perform: signOut,
                      },
                      {
                        kind: "action",
                        id: "switch-person:account",
                        title: "Account settings",
                        keywords: ["password", "name"],
                        leading: { kind: "icon", icon: UserRoundCogIcon },
                        perform: () => window.location.assign(ACCOUNT_SETTINGS),
                      },
                    ],
                  },
                ],
              },
            },
            {
              kind: "action",
              id: "sign-out",
              title: "Sign out",
              keywords: ["log out"],
              leading: { kind: "icon", icon: LogOutIcon },
              perform: signOut,
            },
          ],
        },
      ],
    }),
    [current, setTheme, signOut, name],
  );
};
