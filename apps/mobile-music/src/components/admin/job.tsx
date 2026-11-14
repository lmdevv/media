import { router } from "expo-router";
import { Check, Folder, Info, Music, RotateCw } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { LibraryView } from "@/lib/first-scan";
import type { JobId } from "@/lib/ids";
import {
  jobEta,
  jobName,
  jobPhase,
  jobProgress,
  jobStatusLine,
  keptLine,
  stoppedReason,
} from "@/lib/jobs";
import type { Job } from "@/lib/jobs";
import { useCore } from "@/lib/platform";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";
import { useNow } from "@/components/settings/use-now";

import { useJobs, useLibrary } from "./data";
import { ProgressBar } from "./progress-bar";

/** A job's page: its progress, its result, or how to recover when it stopped. */
export function JobPage({ id }: { readonly id: JobId | null }) {
  const jobs = useJobs();
  const job = jobs?.find((listed) => listed.jobId === id);
  const library = useLibrary(job?.library?.libraryId ?? null);

  if (id === null || (jobs !== undefined && job === undefined)) {
    return (
      <Page title="Library scan" bottom="plain">
        <EmptyState
          icon={RotateCw}
          title={"No such\njob."}
          body={"The link is out of date.\nFind recent scans in Jobs."}
        />
      </Page>
    );
  }

  if (job === undefined) {
    return (
      <Page title="Library scan" bottom="plain">
        {null}
      </Page>
    );
  }

  if (jobPhase(job.status) === "stopped") {
    return <StoppedScan job={job} library={library ?? null} />;
  }

  return <ScanProgress job={job} library={library ?? null} />;
}

interface ScanProps {
  readonly job: Job;
  readonly library: LibraryView | null;
}

/** The library's latest scan, when it is this job: what it knows of the running attempt. */
const scanOf = (job: Job, library: LibraryView | null) =>
  library?.scan?.jobId === job.jobId ? library.scan : null;

function ScanProgress({ job, library }: ScanProps) {
  const now = useNow(5000);
  const progress = jobProgress(job);
  const scan = scanOf(job, library);
  const eta = jobEta(job, scan?.startedAt ?? null, now);
  const name = jobName(job);
  const active = jobPhase(job.status) === "active";
  const folder = library?.folders?.[0];

  const where = [...(folder === undefined ? [] : [folder]), ...(eta === null ? [] : [eta])].join(
    " · ",
  );

  return (
    <Page title="Library scan" bottom="plain">
      <Row
        leading={{ kind: "icon", icon: Folder, tone: "muted" }}
        title={name}
        subtitle={jobStatusLine(job, now)}
      />
      <View className="pt-8 pb-5">
        <Text variant="figure">{progress.stat}</Text>
        <Text tone="muted">{progress.caption}</Text>
      </View>
      {progress.fill === null ? null : <ProgressBar percent={progress.fill} label={name} />}
      <SectionHeader title="Details" />
      {active ? (
        <Row
          leading={{ kind: "icon", icon: Music, tone: "muted" }}
          title={job.status === "queued" ? "Waiting for the scanner" : "Reading artwork and tags"}
          subtitle={where.length === 0 ? (job.message ?? "") : where}
        />
      ) : (
        <Row
          leading={{ kind: "icon", icon: Check, tone: "muted" }}
          title="Done"
          subtitle={job.message ?? "The scan finished."}
        />
      )}
      {active && job.kind === "music.scan" && library?.level === "manage" && !job.canceling ? (
        <View className="pt-6">
          <Button
            label="Cancel scan"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: "/settings/admin/jobs/[id]/cancel",
                params: { id: job.jobId, attempt: String(job.attempts) },
              })
            }
          />
        </View>
      ) : null}
    </Page>
  );
}

function StoppedScan({ job, library }: ScanProps) {
  const core = useCore();
  const action = useAction();

  const resume = (target: LibraryView) =>
    action.run(async () => {
      const { jobId } = await core.libraries.scan({ libraryId: target.libraryId });

      router.replace({ pathname: "/settings/admin/jobs/[id]", params: { id: jobId } });
    });

  return (
    <Page
      title="The scan stopped"
      bottom="plain"
      trailing={
        <IconButton
          icon={Folder}
          label="Libraries"
          onPress={() => router.navigate("/settings/admin/libraries")}
        />
      }
    >
      <Text variant="hero" accessibilityRole="header" className="pt-row pb-6">
        {"Your music\nis still here."}
      </Text>
      <Notice icon={Info} title={keptLine(job.done)} body={stoppedReason(job)} />
      {job.kind === "music.scan" && library?.level === "manage" ? (
        <View className="pt-6">
          <Button
            label="Resume scan"
            pendingLabel="Starting…"
            icon={RotateCw}
            pending={action.pending}
            onPress={() => resume(library)}
          />
        </View>
      ) : null}
      <View className="pt-3">
        <Button label="Use what’s there" variant="secondary" onPress={() => router.back()} />
      </View>
      <Failure message={action.failure} />
    </Page>
  );
}
