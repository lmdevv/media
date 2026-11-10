import { usePlatform } from "@media/sdk/react";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { toastFailure } from "@media/ui/lib/failure";
import { FolderIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { formatCount } from "@/lib/format";
import { useActiveScans, useManagedLibraries } from "@/lib/libraries";
import { scanProgress } from "@/lib/scan-progress";

import type { CommandContext, CommandContribution } from "./contribution";

/**
 * Library scans for people who manage a movies library: running scans with their progress, and
 * scanning everything or one library. The core has no way to cancel a scan.
 */
export const useLibraryCommands = (context: CommandContext): CommandContribution => {
  const platform = usePlatform();
  const edit = context.scopes.has("movies:edit");
  const libraries = useManagedLibraries();
  const scans = useActiveScans(edit ? libraries : []);
  const scan = platform.core.libraries.scan;

  return useMemo((): CommandContribution => {
    if (!edit) return { groups: [] };

    const running = scans.map(({ library, scan: job }): CommandItem => {
      const progress = scanProgress(job);

      const detail =
        job.status === "queued"
          ? "waiting"
          : progress.total === null
            ? `${formatCount(progress.done)} files`
            : `${formatCount(progress.done)} of ${formatCount(progress.total)}`;

      return {
        kind: "action",
        id: `scan-job:${job.jobId}`,
        title: `Scanning ${library.name}`,
        detail,
        keywords: ["scan", "job"],
        leading: { kind: "icon", icon: RefreshCwIcon },
        progress: progress.fraction ?? 0,
        keepOpen: true,
        perform: () => undefined,
      };
    });

    const scanAll = async (): Promise<void> => {
      try {
        await Promise.all(libraries.map((library) => scan({ libraryId: library.libraryId })));
        toast.success(
          libraries.length === 1
            ? "Scanning your library"
            : `Scanning ${libraries.length} libraries`,
        );
      } catch (cause) {
        toastFailure(cause);
      }
    };

    const scanLibraries: CommandItem = {
      kind: "action",
      id: "scan:all",
      title: "Scan libraries",
      keywords: ["rescan", "refresh", "library"],
      leading: { kind: "icon", icon: RefreshCwIcon },
      perform: scanAll,
    };

    const scanOne: CommandItem = {
      kind: "submenu",
      id: "scan:one",
      title: "Scan one library…",
      keywords: ["scan", "rescan", "library", "folder"],
      leading: { kind: "icon", icon: FolderIcon },
      page: {
        id: "scan:one",
        breadcrumb: "Scan library",
        placeholder: "Library…",
        groups: [
          {
            id: "libraries",
            items: libraries.map((library): CommandItem => ({
              kind: "action",
              id: `scan:${library.libraryId}`,
              title: library.name,
              leading: { kind: "icon", icon: FolderIcon },
              perform: async () => {
                try {
                  await scan({ libraryId: library.libraryId });
                  toast.success(`Scanning ${library.name}`);
                } catch (cause) {
                  toastFailure(cause);
                }
              },
            })),
          },
        ],
      },
    };

    return {
      groups: [
        {
          id: "library",
          label: "Library",
          items: [...running, ...(libraries.length === 0 ? [] : [scanLibraries, scanOne])],
        },
      ],
      fallback: libraries.length === 0 ? [] : [scanLibraries],
    };
  }, [edit, scans, libraries, scan]);
};
