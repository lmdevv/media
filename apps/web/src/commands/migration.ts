import { useCommand, useCommandQuery } from "@media/sdk/react";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { CircleXIcon, DownloadIcon, LoaderIcon } from "lucide-react";
import { useMemo } from "react";

import { SOURCE_NAMES, importFraction } from "@media/contracts/migration-plan";

import { PHASE_LABELS } from "@/components/migration/migration-model";
import { toastFailure } from "@/lib/failure";
import { formatPercent } from "@/components/admin/format";
import { isActive } from "@/lib/scan-progress";

import type { CommandContext, CommandContribution } from "./contribution";

/**
 * Migration for `admin` sessions: open the import from Jellyfin or Plex, and while an import runs,
 * its progress and a way to cancel it.
 */
export const useMigrationCommands = (context: CommandContext): CommandContribution => {
  const { navigate, scopes } = context;
  const admin = scopes.has("admin");
  const runs = useCommandQuery("migration.status", admin ? {} : "skip");
  const cancel = useCommand("jobs.cancel");

  return useMemo((): CommandContribution => {
    if (!admin) return { groups: [] };

    const running = runs.status === "success" ? runs.data.filter((run) => isActive(run.job)) : [];

    const open: CommandItem = {
      kind: "action",
      id: "go:/admin/migration",
      title: "Import from Jellyfin or Plex",
      keywords: ["migration", "migrate", "jellyfin", "plex", "import", "admin"],
      leading: { kind: "icon", icon: DownloadIcon },
      perform: () => navigate({ to: "/admin/migration" }),
    };

    const progress = running.map((run): CommandItem => {
      const fraction = importFraction(run);

      return {
        kind: "action",
        id: `migration-job:${run.job.id}`,
        title: `Importing from ${SOURCE_NAMES[run.source]}`,
        detail: `${formatPercent(fraction)} · ${PHASE_LABELS[run.phase]}`,
        keywords: ["migration", "import", "job"],
        leading: { kind: "icon", icon: LoaderIcon },
        progress: fraction,
        perform: () => navigate({ to: "/admin/migration", search: { job: run.job.id } }),
      };
    });

    const stop: ReadonlyArray<CommandItem> =
      running.length === 0
        ? []
        : [
            {
              kind: "action",
              id: "migration:cancel",
              title: "Cancel import",
              keywords: ["stop", "migration", "jellyfin", "plex"],
              leading: { kind: "icon", icon: CircleXIcon },
              perform: async () => {
                try {
                  await Promise.all(running.map((run) => cancel({ jobId: run.job.id })));
                } catch (cause) {
                  toastFailure(cause);
                }
              },
            },
          ];

    return {
      groups: [
        { id: "go", label: "Go to", items: [open] },
        { id: "actions", label: "Actions", items: [...progress, ...stop] },
      ],
    };
  }, [admin, runs, navigate, cancel]);
};
