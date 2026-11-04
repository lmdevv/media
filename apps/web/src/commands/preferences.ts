import type { CommandItem } from "@media/ui/lib/command-menu";
import { LogOutIcon, MonitorIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useMemo } from "react";

import { useSignOut } from "@/session/viewer";

import type { CommandContribution } from "./contribution";

type ThemeChoice = "dark" | "light" | "system";

const THEMES: ReadonlyArray<{ readonly id: ThemeChoice; readonly title: string }> = [
  { id: "dark", title: "Dark" },
  { id: "light", title: "Light" },
  { id: "system", title: "Match system" },
];

/** This browser's preferences and the session: the theme and signing out. */
export const usePreferenceCommands = (): CommandContribution => {
  const { theme, setTheme } = useTheme();
  const signOut = useSignOut();
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
    [current, setTheme, signOut],
  );
};
