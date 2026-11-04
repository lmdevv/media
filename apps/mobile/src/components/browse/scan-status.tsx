import type { Job } from "@media/contracts/models/jobs";
import type { Library } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { Folder } from "lucide-react-native";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { ProgressBar } from "@/components/ui/progress-bar";

const JOB_WINDOW = 20;

const progressOf = (
  job: Job | undefined,
): { readonly detail: string; readonly value: number } | null => {
  if (job === undefined || job.progress.total === null || job.progress.total <= 0) return null;

  return {
    detail: `${job.progress.done} of ${job.progress.total}`,
    value: Math.min(1, job.progress.done / job.progress.total),
  };
};

/** One row per scanning library, with counts for sessions that manage libraries. */
export function ScanStatus({ libraries }: { readonly libraries: ReadonlyArray<Library> }) {
  const viewer = useCommandQuery("account.viewer", {});
  const manage = viewer.status === "success" && viewer.data.scopes.includes("manage");
  const jobs = useCommandQuery("jobs.list", manage ? { kind: "scan", limit: JOB_WINDOW } : "skip");

  const running =
    jobs.status === "success" ? jobs.data.filter((job) => job.status === "running") : [];

  return (
    <View className="gap-4 px-5 regular:px-8 wide:px-12">
      {libraries
        .filter((library) => library.scanning)
        .map((library) => {
          const job = running.find(
            (candidate) =>
              candidate.payload.kind === "scan" && candidate.payload.libraryId === library.id,
          );

          const progress = progressOf(job);
          const title = `Scanning ${library.name}`;

          return (
            <View key={library.id} className="gap-4">
              {progress === null ? (
                <ListRow icon={Folder} title={title} />
              ) : (
                <ListRow icon={Folder} title={title} detail={progress.detail} />
              )}
              {progress === null ? null : <ProgressBar value={progress.value} />}
            </View>
          );
        })}
    </View>
  );
}
