/**
 * F19 · Library scan: one job, live. While it waits or runs it shows its progress, time left, and
 * Cancel scan; once done, what the scanner reported. A failed or cancelled scan is G09: what was
 * kept, why it stopped, and a way to scan again.
 */
import type { JobId } from "@music/commands/ids";
import type { Job, Library } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
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
import { jobEta, jobPhase, jobProgress, jobStatusLine, keptLine, stoppedReason } from "@/lib/jobs";

import { useLibrary } from "./data";
import { Failure } from "@/components/settings/failure";
import { ProgressBar } from "./progress-bar";
import { useAction } from "@/components/settings/use-action";
import { useNow } from "@/components/settings/use-now";

/** A job's page: its progress, its result, or how to recover when it stopped. */
export function JobPage({ id }: { readonly id: JobId | null }) {
  const job = useRead("jobs.get", id === null ? "skip" : { jobId: id });
  const library = useLibrary(job?.libraryId ?? null);

  if (id === null) {
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

/** Props for a job's page once the job has loaded. */
interface ScanProps {
  readonly job: Job;
  /** Its library, or null when it is gone or hidden from the caller. */
  readonly library: Library | null;
}

/** F19: a waiting, running, or finished scan. */
function ScanProgress({ job, library }: ScanProps) {
  const now = useNow(5000);
  const progress = jobProgress(job);
  const eta = jobEta(job, now);
  const name = library?.name ?? job.label;
  const active = jobPhase(job.status) === "active";

  const where = [
    ...(library?.path === null || library?.path === undefined ? [] : [library.path]),
    ...(eta === null ? [] : [eta]),
  ].join(" · ");

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
          title={job.status === "pending" ? "Waiting for the scanner" : "Reading artwork and tags"}
          subtitle={where.length === 0 ? (job.message ?? "") : where}
        />
      ) : (
        <Row
          leading={{ kind: "icon", icon: Check, tone: "muted" }}
          title="Done"
          subtitle={job.message ?? "The scan finished."}
        />
      )}
      {active ? (
        <View className="pt-6">
          <Button
            label="Cancel scan"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: "/settings/admin/jobs/[id]/cancel", params: { id: job.id } })
            }
          />
        </View>
      ) : null}
    </Page>
  );
}

/** G09: a scan that failed or was cancelled. The music it read stays. */
function StoppedScan({ job, library }: ScanProps) {
  const scan = useRun("libraries.scan");
  const action = useAction();

  const resume = (target: Library) =>
    action.run(async () => {
      const { jobId } = await scan({ libraryId: target.id });

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
      {library?.manageable === true ? (
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
