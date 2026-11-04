import { JobId, LibraryId } from "@media/contracts/ids";
import type { LibraryDetail } from "@media/contracts/models/catalog";
import type { Job } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Clapperboard, RotateCcw, Search } from "lucide-react-native";

import { LoadFailure, Loading, Meter, OwnerScreen } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { formatCount } from "@/lib/owner-format";
import { folderTrouble, isActive, isStopped, scanCount, scanLine } from "@/lib/scans";
import { useFinishSetup } from "@/session/finish-setup";
import { useSessionPhase } from "@/session/session-phase";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

const decodeJobId = Schema.decodeUnknownSync(JobId);

const useScan = (libraryId: LibraryId, jobId: string | undefined): QueryState<Job | null> => {
  const named = useCommandQuery(
    "jobs.get",
    jobId === undefined ? "skip" : { jobId: decodeJobId(jobId) },
  );

  const recent = useCommandQuery(
    "jobs.list",
    jobId === undefined ? { kind: "scan", libraryId, limit: 1 } : "skip",
  );

  if (jobId !== undefined) return named;

  if (recent.status !== "success") return recent;

  return { status: "success", data: recent.data[0] ?? null };
};

const lineFor = (job: Job): string => {
  const trouble = folderTrouble(job);

  if (trouble === "offline") return "The NAS can’t be reached.";

  if (trouble === "notApproved") return "This folder isn’t available to the server.";

  return scanLine(job);
};

const meterLabel = (job: Job): string => {
  const count = scanCount(job);

  if (count !== null) return count.label;

  return job.status === "pending" ? "Starting" : `${formatCount(job.progress.done)} Files`;
};

function ScanView({ library, job }: { readonly library: LibraryDetail; readonly job: Job }) {
  const phase = useSessionPhase();
  const finishSetup = useFinishSetup();
  const cancel = useCommand("jobs.cancel");
  const scan = useCommand("libraries.scan");
  const summary = useCommandQuery("libraries.fileSummary", { libraryId: library.id });
  const active = isActive(job);
  const count = scanCount(job);

  const leave = () => {
    if (phase.kind === "setup") {
      void finishSetup();

      return;
    }

    if (router.canGoBack()) router.back();
    else
      router.replace({
        pathname: "/owner/libraries/[libraryId]",
        params: { libraryId: library.id },
      });
  };

  const stop = useTask(() => cancel({ jobId: job.id }));

  const retry = useTask(async () => {
    const queued = await scan({ libraryId: library.id, mode: "full" });

    router.setParams({ jobId: queued.jobId });
  });

  const unmatched = summary.status === "success" ? summary.data.unmatchedTitles : null;
  const error = stop.error ?? retry.error;

  return (
    <>
      <Meter
        label={meterLabel(job)}
        value={count?.fraction ?? 0}
        accessibilityLabel={`${library.name}: ${meterLabel(job)}`}
      />
      <Text tone="muted" accessibilityLiveRegion="polite">
        {lineFor(job)}
      </Text>
      <ListRow
        icon={Clapperboard}
        title={library.kind === "shows" ? "Shows" : "Titles"}
        detail={formatCount(library.titleCount)}
      />
      <ListRow
        icon={Search}
        title="Needs Review"
        detail={unmatched === null ? undefined : formatCount(unmatched)}
        onPress={
          unmatched === null || unmatched === 0
            ? undefined
            : () =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]/files",
                  params: { libraryId: library.id, filter: "unmatched" },
                })
        }
      />
      {error === null ? null : (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      )}
      {isStopped(job) ? (
        <>
          <Button
            label="Retry Scan"
            icon={RotateCcw}
            busy={retry.busy}
            onPress={() => void retry.run()}
          />
          {folderTrouble(job) === null ? null : (
            <Button
              label="Edit Folder"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]/edit",
                  params: { libraryId: library.id },
                })
              }
            />
          )}
          <Button label="Keep Browsing" variant="plain" onPress={leave} />
        </>
      ) : active ? (
        <>
          <Button label="Keep Browsing" variant="secondary" onPress={leave} />
          <Button
            label="Cancel Scan"
            variant="destructive"
            busy={stop.busy}
            onPress={() => void stop.run()}
          />
        </>
      ) : (
        <Button label="Done" onPress={leave} />
      )}
    </>
  );
}

export default function ScanLibrary() {
  const params = useLocalSearchParams<{ libraryId: string; jobId?: string }>();
  const libraryId = decodeLibraryId(params.libraryId);
  const library = useCommandQuery("libraries.get", { libraryId });
  const job = useScan(libraryId, params.jobId);
  const name = library.status === "success" ? library.data.name : "Library";
  const current = job.status === "success" ? job.data : null;
  const title = current !== null && isActive(current) ? `Scanning ${name}` : name;

  return (
    <OwnerScreen title={title} fallback="/owner/libraries">
      {library.status === "error" ? (
        <LoadFailure error={library.error} retry={library.retry} />
      ) : job.status === "error" ? (
        <LoadFailure error={job.error} retry={job.retry} />
      ) : library.status === "loading" || job.status === "loading" ? (
        <Loading />
      ) : job.data === null ? (
        <Text tone="muted" className="pt-8">
          No scan to show yet.
        </Text>
      ) : (
        <ScanView library={library.data} job={job.data} />
      )}
    </OwnerScreen>
  );
}
