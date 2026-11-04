import type { Job } from "@media/contracts/models/jobs";
import type { Library } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import type { CommandItem } from "@media/ui/lib/command-menu";
import { CircleXIcon, FolderIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/failure";
import { formatCount } from "@/lib/format";
import { isActive, scanProgress } from "@/lib/scan-progress";
import { useNow } from "@/lib/use-now";

import type { CommandContext, CommandContribution } from "./contribution";

const JOB_WINDOW = 20;

/** Live scan jobs of the libraries `manage` sessions see, for the menu and the scanning toast. */
export const useActiveScans = (
  enabled: boolean,
): { readonly jobs: ReadonlyArray<Job>; readonly libraries: ReadonlyArray<Library> } => {
  const jobs = useCommandQuery("jobs.list", enabled ? { kind: "scan", limit: JOB_WINDOW } : "skip");
  const libraries = useCommandQuery("libraries.list", enabled ? {} : "skip");

  return useMemo(
    () => ({
      jobs: jobs.status === "success" ? jobs.data.filter(isActive) : [],
      libraries: libraries.status === "success" ? libraries.data : [],
    }),
    [jobs, libraries],
  );
};

const libraryName = (libraries: ReadonlyArray<Library>, job: Job): string => {
  const libraryId = job.payload.kind === "scan" ? job.payload.libraryId : null;

  return libraries.find((library) => library.id === libraryId)?.name ?? "library";
};

/**
 * Library scans for `manage` sessions: running scans with their progress, scanning everything or
 * one library, and cancelling running scans.
 */
export const useLibraryCommands = (context: CommandContext): CommandContribution => {
  const manage = context.scopes.has("manage");
  const { jobs, libraries } = useActiveScans(manage);
  const scan = useCommand("libraries.scan");
  const cancel = useCommand("jobs.cancel");
  const now = useNow(10_000);

  return useMemo((): CommandContribution => {
    if (!manage) return { groups: [] };

    const running = jobs.map((job): CommandItem => {
      const progress = scanProgress(job, now);

      const detail =
        job.status === "pending"
          ? "waiting"
          : [
              progress.total === null
                ? `${formatCount(progress.done)} files`
                : `${formatCount(progress.done)} of ${formatCount(progress.total)}`,
              progress.minutesLeft === null ? null : `about ${progress.minutesLeft}m`,
            ]
              .filter((part) => part !== null)
              .join(" · ");

      return {
        kind: "action",
        id: `scan-job:${job.id}`,
        title: `Scanning ${libraryName(libraries, job)}`,
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
        await Promise.all(libraries.map((library) => scan({ libraryId: library.id })));
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
              id: `scan:${library.id}`,
              title: library.name,
              detail: `${formatCount(library.titleCount)} titles`,
              leading: { kind: "icon", icon: FolderIcon },
              perform: async () => {
                try {
                  await scan({ libraryId: library.id });
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

    const cancelScans: ReadonlyArray<CommandItem> =
      jobs.length === 0
        ? []
        : [
            {
              kind: "action",
              id: "scan:cancel",
              title: jobs.length === 1 ? "Cancel scan" : "Cancel scans",
              keywords: ["stop", "scan"],
              leading: { kind: "icon", icon: CircleXIcon },
              perform: async () => {
                try {
                  await Promise.all(jobs.map((job) => cancel({ jobId: job.id })));
                } catch (cause) {
                  toastFailure(cause);
                }
              },
            },
          ];

    return {
      groups: [
        {
          id: "library",
          label: "Library",
          items: [
            ...running,
            ...(libraries.length === 0 ? [] : [scanLibraries, scanOne]),
            ...cancelScans,
          ],
        },
      ],
      fallback: libraries.length === 0 ? [] : [scanLibraries],
    };
  }, [manage, jobs, libraries, now, scan, cancel]);
};
