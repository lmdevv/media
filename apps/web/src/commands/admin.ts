import { useCommand } from "@media/sdk/react";
import type { CommandItem } from "@media/ui/lib/command-menu";
import {
  ArchiveIcon,
  FolderPlusIcon,
  LibraryIcon,
  ServerIcon,
  UploadIcon,
  UserPlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/failure";

import type { CommandContext, CommandContribution } from "./contribution";

/**
 * Server administration, by scope: `manage` goes to Libraries and adds one; `admin` goes to Users,
 * Backups, and Server, invites someone, and backs up now. Scanning lives in `library.ts`.
 */
export const useAdminCommands = (context: CommandContext): CommandContribution => {
  const { navigate, scopes } = context;
  const manage = scopes.has("manage");
  const admin = scopes.has("admin");
  const backUp = useCommand("backups.run");

  return useMemo((): CommandContribution => {
    const managing: ReadonlyArray<CommandItem> = manage
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

    const administering: ReadonlyArray<CommandItem> = admin
      ? [
          {
            kind: "action",
            id: "go:/admin/users",
            title: "Users",
            keywords: ["admin", "accounts", "invites", "access"],
            leading: { kind: "icon", icon: UsersRoundIcon },
            perform: () => navigate({ to: "/admin/users" }),
          },
          {
            kind: "action",
            id: "go:/admin/backups",
            title: "Backups",
            keywords: ["admin", "restore"],
            leading: { kind: "icon", icon: ArchiveIcon },
            perform: () => navigate({ to: "/admin/backups" }),
          },
        ]
      : [];

    const server: ReadonlyArray<CommandItem> =
      manage || admin
        ? [
            {
              kind: "action",
              id: "go:/admin/server",
              title: "Server",
              keywords: ["admin", "health", "transcoding", "media service"],
              leading: { kind: "icon", icon: ServerIcon },
              perform: () => navigate({ to: "/admin/server" }),
            },
          ]
        : [];

    const actions: ReadonlyArray<CommandItem> = [
      ...(manage
        ? [
            {
              kind: "action",
              id: "library:add",
              title: "Add library",
              keywords: ["new", "folder"],
              leading: { kind: "icon", icon: FolderPlusIcon },
              perform: () => navigate({ to: "/admin/libraries", search: { dialog: "add" } }),
            } satisfies CommandItem,
          ]
        : []),
      ...(admin
        ? [
            {
              kind: "action",
              id: "invite:new",
              title: "Invite someone",
              keywords: ["invite", "user", "account", "link"],
              leading: { kind: "icon", icon: UserPlusIcon },
              perform: () => navigate({ to: "/admin/users" }),
            } satisfies CommandItem,
            {
              kind: "action",
              id: "backup:run",
              title: "Back up now",
              keywords: ["backup", "snapshot"],
              leading: { kind: "icon", icon: UploadIcon },
              perform: async () => {
                try {
                  await backUp({});
                  toast.success("Backing up now");
                } catch (cause) {
                  toastFailure(cause);
                }
              },
            } satisfies CommandItem,
          ]
        : []),
    ];

    return {
      groups: [
        { id: "go", label: "Go to", items: [...managing, ...administering, ...server] },
        { id: "actions", label: "Actions", items: actions },
      ],
    };
  }, [navigate, manage, admin, backUp]);
};
