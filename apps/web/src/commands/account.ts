import type { CommandItem } from "@media/ui/lib/command-menu";
import { KeyRoundIcon, MonitorSmartphoneIcon, PlusIcon, UserRoundCogIcon } from "lucide-react";
import { useMemo } from "react";

import type { CommandContext, CommandContribution } from "./contribution";

const DEVICE_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u;

/** The device code typed into the menu, upper-cased, or null when the query is not one. */
export const typedDeviceCode = (query: string): string | null => {
  const code = query.trim().toUpperCase();

  return DEVICE_CODE.test(code) ? code : null;
};

/**
 * The signed-in account's own settings: going to Account, Devices, and API keys, creating a key,
 * and approving a device's sign-in, directly when a device code is typed.
 */
export const useAccountCommands = (context: CommandContext): CommandContribution => {
  const { navigate, query } = context;

  return useMemo((): CommandContribution => {
    const go: ReadonlyArray<CommandItem> = [
      {
        kind: "action",
        id: "go:/settings/account",
        title: "Account",
        keywords: ["settings", "email", "role"],
        leading: { kind: "icon", icon: UserRoundCogIcon },
        perform: () => navigate({ to: "/settings/account" }),
      },
      {
        kind: "action",
        id: "go:/settings/devices",
        title: "Devices",
        keywords: ["settings", "sessions", "signed in"],
        leading: { kind: "icon", icon: MonitorSmartphoneIcon },
        perform: () => navigate({ to: "/settings/devices" }),
      },
      {
        kind: "action",
        id: "go:/settings/api-keys",
        title: "API keys",
        keywords: ["settings", "tokens", "agents"],
        leading: { kind: "icon", icon: KeyRoundIcon },
        perform: () => navigate({ to: "/settings/api-keys" }),
      },
    ];

    const actions: ReadonlyArray<CommandItem> = [
      {
        kind: "action",
        id: "api-key:create",
        title: "Create API key",
        keywords: ["new", "token", "agent"],
        leading: { kind: "icon", icon: PlusIcon },
        perform: () => navigate({ to: "/settings/api-keys", search: { dialog: "create" } }),
      },
      {
        kind: "action",
        id: "device:approve",
        title: "Sign in a device",
        keywords: ["approve", "code", "tv", "link"],
        leading: { kind: "icon", icon: MonitorSmartphoneIcon },
        perform: () => navigate({ to: "/device" }),
      },
    ];

    const code = typedDeviceCode(query);

    return {
      groups: [
        { id: "go", label: "Go to", items: go },
        { id: "actions", label: "Actions", items: actions },
      ],
      fallback:
        code === null
          ? []
          : [
              {
                kind: "action",
                id: "device:approve-code",
                title: `Approve device code ${code}`,
                leading: { kind: "icon", icon: MonitorSmartphoneIcon },
                perform: () => navigate({ to: "/device", search: { code } }),
              },
            ],
    };
  }, [navigate, query]);
};
