import type { CommandItem } from "@media/ui/lib/command-menu";
import { LibraryBigIcon, SearchIcon, Settings2Icon, UserRoundCogIcon } from "lucide-react";
import { useMemo } from "react";

import { SECTIONS } from "@/components/shell/sections";
import { ACCOUNT_SETTINGS } from "@/lib/account-links";
import { keymap } from "@/lib/keymap";

import type { CommandContext, CommandContribution } from "./contribution";

/**
 * "Go to": the four sections, Collections, Settings, and the person's account on the account
 * client; sections have a `g` shortcut.
 */
export const useNavigationCommands = (context: CommandContext): CommandContribution => {
  const { navigate, query } = context;

  return useMemo((): CommandContribution => {
    const sections = SECTIONS.map((section): CommandItem => ({
      kind: "action",
      id: `go:${section.to}`,
      title: section.label,
      leading: { kind: "icon", icon: section.icon },
      keycaps: keymap.keycaps(section.shortcut),
      perform: () => navigate({ to: section.to }),
    }));

    const collections: CommandItem = {
      kind: "action",
      id: "go:/collections",
      title: "Collections",
      leading: { kind: "icon", icon: LibraryBigIcon },
      perform: () => navigate({ to: "/collections" }),
    };

    const settings: CommandItem = {
      kind: "action",
      id: "go:/settings",
      title: "Settings",
      leading: { kind: "icon", icon: Settings2Icon },
      keycaps: keymap.keycaps("go.settings"),
      perform: () => navigate({ to: "/settings" }),
    };

    const account: CommandItem = {
      kind: "action",
      id: "go:account",
      title: "Account",
      keywords: ["settings", "password", "name", "subtitles", "language"],
      leading: { kind: "icon", icon: UserRoundCogIcon },
      perform: () => window.location.assign(ACCOUNT_SETTINGS),
    };

    const trimmed = query.trim();

    return {
      groups: [{ id: "go", label: "Go to", items: [...sections, collections, settings, account] }],
      fallback:
        trimmed === ""
          ? []
          : [
              {
                kind: "action",
                id: "search:page",
                title: `Search all titles for “${trimmed}”`,
                leading: { kind: "icon", icon: SearchIcon },
                perform: () => navigate({ to: "/search", search: { q: trimmed } }),
              },
            ],
    };
  }, [navigate, query]);
};
