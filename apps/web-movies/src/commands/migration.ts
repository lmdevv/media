import { SOURCE_NAMES } from "@media/contracts/migration-plan";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { DownloadIcon, LoaderIcon } from "lucide-react";
import { useMemo } from "react";

import { formatPercent } from "@/components/admin/format";
import { PHASE_LABELS } from "@/components/migration/migration-model";
import { orSkip } from "@/lib/query-state";
import { isActive, scanProgress } from "@/lib/scan-progress";

import type { CommandContext, CommandContribution } from "./contribution";

/** Imports listed for progress: the newest, where a running one is. */
const RECENT_IMPORTS = 10;

/**
 * Importing for `admin` sessions: open the import from Jellyfin or Plex, and while an import runs,
 * its progress. The core has no way to cancel an import's job.
 */
export const useMigrationCommands = (context: CommandContext): CommandContribution => {
  const platform = usePlatform();
  const { navigate, scopes } = context;
  const admin = scopes.has("admin");

  const runs = usePlatformQuery(
    platform.movies.imports.list,
    ...orSkip(admin ? { paginationOpts: { numItems: RECENT_IMPORTS, cursor: null } } : null),
  );

  return useMemo((): CommandContribution => {
    if (!admin) return { groups: [] };

    const running =
      runs.status === "success" ? runs.data.page.filter((run) => isActive(run.job)) : [];

    const open: CommandItem = {
      kind: "action",
      id: "go:/admin/migration",
      title: "Import from Jellyfin or Plex",
      keywords: ["migration", "migrate", "jellyfin", "plex", "import", "admin"],
      leading: { kind: "icon", icon: DownloadIcon },
      perform: () => navigate({ to: "/admin/migration" }),
    };

    const progress = running.map((run): CommandItem => {
      const fraction = scanProgress(run.job).fraction ?? 0;

      return {
        kind: "action",
        id: `migration-job:${run.job.jobId}`,
        title: `Importing from ${SOURCE_NAMES[run.source]}`,
        detail: `${formatPercent(fraction)} · ${PHASE_LABELS[run.phase]}`,
        keywords: ["migration", "import", "job"],
        leading: { kind: "icon", icon: LoaderIcon },
        progress: fraction,
        perform: () => navigate({ to: "/admin/migration", search: { run: run.importId } }),
      };
    });

    return {
      groups: [
        { id: "go", label: "Go to", items: [open] },
        { id: "actions", label: "Actions", items: progress },
      ],
    };
  }, [admin, runs, navigate]);
};
