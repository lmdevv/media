import { router } from "expo-router";
import { Check, Info, Monitor, RotateCw } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { jobLine, jobName, jobPhase, splitJobs } from "@/lib/jobs";
import type { Job, JobPhase } from "@/lib/jobs";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useNow } from "@/components/settings/use-now";

import { useJobs } from "./data";

const GLYPHS: Readonly<Record<JobPhase, LucideIcon>> = {
  active: RotateCw,
  done: Check,
  stopped: Info,
};

function JobRow({ job, now }: { readonly job: Job; readonly now: number }) {
  const phase = jobPhase(job.status);
  const name = jobName(job);

  return (
    <Row
      leading={{ kind: "icon", icon: GLYPHS[phase], tone: "muted" }}
      title={phase === "active" && job.kind === "music.scan" ? `Scanning ${name}` : name}
      subtitle={jobLine(job, now)}
      trailing={<RowChevron />}
      onPress={() =>
        router.push({ pathname: "/settings/admin/jobs/[id]", params: { id: job.jobId } })
      }
    />
  );
}

/** Recent server jobs, running first. */
export function JobsList() {
  const jobs = useJobs();
  const now = useNow(30_000);

  if (jobs === undefined) {
    return (
      <Page title="Jobs" bottom="plain" trailing={<NavGlyph icon={RotateCw} />}>
        {null}
      </Page>
    );
  }

  const { running, recent } = splitJobs(jobs);

  return (
    <Page title="Jobs" bottom="plain" trailing={<NavGlyph icon={RotateCw} />}>
      {jobs.length === 0 ? (
        <EmptyState
          icon={RotateCw}
          title={"Nothing\nrunning."}
          body={"Scans show up here\nwhile they run."}
        />
      ) : (
        <>
          {running.length === 0 ? null : <SectionHeader title="Running" />}
          {running.map((job) => (
            <JobRow key={job.jobId} job={job} now={now} />
          ))}
          {recent.length === 0 ? null : <SectionHeader title="Recent" />}
          {recent.map((job) => (
            <JobRow key={job.jobId} job={job} now={now} />
          ))}
          <Notice
            icon={Monitor}
            title="Jobs run on your server"
            body="You can leave the app while a scan continues."
          />
        </>
      )}
    </Page>
  );
}
