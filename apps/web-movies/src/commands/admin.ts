import type { CommandItem } from "@media/ui/lib/command-menu";
import { FolderPlusIcon, LibraryIcon } from "lucide-react";
import { useMemo } from "react";

import { ACCOUNT_LIBRARIES } from "@/lib/account-links";

import type { CommandContext, CommandContribution } from "./contribution";

/**
 * Library administration, by scope: `movies:edit` goes to Libraries; `admin` adds a library on the
 * account client, where libraries are made. Users, backups, and the server live on the account
 * client's admin. Scanning lives in `library.ts`, importing in `migration.ts`.
 */
export const useAdminCommands = (context: CommandContext): CommandContribution => {
  const { navigate, scopes } = context;
  const edit = scopes.has("movies:edit");
  const admin = scopes.has("admin");

  return useMemo((): CommandContribution => {
    const go: ReadonlyArray<CommandItem> = edit
      ? [
          {
            kind: "action",
            id: "go:/admin/libraries",
            title: "Libraries",
            keywords: ["admin", "folders", "scans", "files"],
            leading: { kind: "icon", icon: LibraryIcon },
            perform: () => navigate({ to: "/admin/libraries" }),
          },
        ]
      : [];

    const actions: ReadonlyArray<CommandItem> = admin
      ? [
          {
            kind: "action",
            id: "library:add",
            title: "Add library",
            keywords: ["new", "folder"],
            leading: { kind: "icon", icon: FolderPlusIcon },
            perform: () => window.location.assign(ACCOUNT_LIBRARIES),
          },
        ]
      : [];

    return {
      groups: [
        { id: "go", label: "Go to", items: go },
        { id: "actions", label: "Actions", items: actions },
      ],
    };
  }, [navigate, edit, admin]);
};
