/**
 * F18 · Jobs: scans still going, then recent ones, each with its state as a glyph and words. The
 * list is live, so Paper's refresh glyph only names the screen. The server returns at most 30
 * recent jobs, so they stay in the page's scroll.
 */
import type { Job } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Check, Info, Monitor, RotateCw } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { jobLine, jobPhase, splitJobs } from "@/lib/jobs";
import type { JobPhase } from "@/lib/jobs";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useNow } from "@/components/settings/use-now";

/** The glyph for each phase: refresh while going, a check when done, info when stopped. */
const GLYPHS: Readonly<Record<JobPhase, LucideIcon>> = {
  active: RotateCw,
  done: Check,
  stopped: Info,
};

/** Props for `JobRow`. */
interface JobRowProps {
  readonly job: Job;
  /** The library's name, or the job's own label when the library is gone. */
  readonly name: string;
  readonly now: number;
}

function JobRow({ job, name, now }: JobRowProps) {
  const phase = jobPhase(job.status);

  return (
    <Row
      leading={{ kind: "icon", icon: GLYPHS[phase], tone: "muted" }}
      title={phase === "active" ? `Scanning ${name}` : name}
      subtitle={jobLine(job, now)}
      trailing={<RowChevron />}
      onPress={() => router.push({ pathname: "/settings/admin/jobs/[id]", params: { id: job.id } })}
    />
  );
}

/** Recent server jobs, running first. */
export function JobsList() {
  const jobs = useRead("jobs.list", {});
  const libraries = useRead("libraries.list", {});
  const now = useNow(30_000);
  const names = new Map(libraries?.map((library) => [library.id, library.name]));
  const nameOf = (job: Job) => (job.libraryId === null ? undefined : names.get(job.libraryId));

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
            <JobRow key={job.id} job={job} name={nameOf(job) ?? job.label} now={now} />
          ))}
          {recent.length === 0 ? null : <SectionHeader title="Recent" />}
          {recent.map((job) => (
            <JobRow key={job.id} job={job} name={nameOf(job) ?? job.label} now={now} />
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
