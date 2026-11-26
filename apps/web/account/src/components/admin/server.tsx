import { TranscodeLabels } from "@media/sdk/effect";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Skeleton } from "@media/ui/components/skeleton";
import { describeFailure } from "@media/ui/lib/failure";
import { cn } from "@media/ui/lib/utils";
import { Match } from "effect";
import { CircleCheck, CirclePause, CircleX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/page-header";

import { useNow } from "@media/ui/lib/use-now";
import { Failed, formatTime } from "./parts";
import type { ServerStatus } from "./types";

/**
 * The media server reports itself every five minutes while nothing changes; two missed reports
 * mean it stopped.
 */
const STALE_MS = 10 * 60 * 1000;

const NOW_EVERY_MS = 30_000;

type Reported = NonNullable<ServerStatus>;

type Transcoding = Reported["transcoding"];

/** What the server page shows. */
export type ServerState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string; readonly retry: () => void }
  | { readonly kind: "ready"; readonly status: ServerStatus };

/** Whether the media server is running, as its last report says. */
type Health = "checking" | "never" | "down" | "up";

const healthOf = (state: ServerState, now: number): Health => {
  if (state.kind !== "ready") return "checking";

  if (state.status === null) return "never";

  return now - state.status.reportedAt > STALE_MS ? "down" : "up";
};

const HEALTH_LABELS: Readonly<Record<Health, string>> = {
  checking: "checking…",
  never: "media service has not reported",
  down: "media service not responding",
  up: "media service running",
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Server: whether the media service runs, its GPU and what it was shown to do, its streams, and where. */
export function ServerScreen({
  mediaUrl,
  databaseUrl,
}: {
  readonly mediaUrl: string;
  /** The core's Convex address. */
  readonly databaseUrl: string;
}) {
  const platform = usePlatform();
  const status = usePlatformQuery(platform.core.server.status, {});
  const info = usePlatformQuery(platform.core.server.info, {});
  const now = useNow(NOW_EVERY_MS);

  const state = Match.value(status).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: (): ServerState => ({ kind: "loading" }),
      error: ({ error, retry }): ServerState => ({
        kind: "failed",
        message: describeFailure(error),
        retry,
      }),
      success: ({ data }): ServerState => ({ kind: "ready", status: data }),
    }),
  );

  return (
    <ServerView
      state={state}
      databaseVersion={info.status === "success" ? info.data.version : null}
      mediaUrl={mediaUrl}
      databaseUrl={databaseUrl}
      now={now}
    />
  );
}

/** The server page while the media service's report loads. */
export function ServerSkeleton({ mediaUrl }: { readonly mediaUrl: string }) {
  return (
    <>
      <ServerHeader mediaUrl={mediaUrl} health="checking" />
      <ReportsSkeleton />
    </>
  );
}

function ServerHeader({
  mediaUrl,
  health,
}: {
  readonly mediaUrl: string;
  readonly health: Health;
}) {
  return (
    <PageHeader
      title="Server"
      facts={
        <span className="font-sans text-label/label">
          {hostOf(mediaUrl)} · {HEALTH_LABELS[health]}
        </span>
      }
    />
  );
}

/** The reports while they load: hardware transcoding, then the six settings rows. */
function ReportsSkeleton() {
  return (
    <>
      <Skeleton aria-label="Loading" className="h-10 w-64 rounded-control" />
      <Skeleton className="h-66 w-full rounded-control" />
    </>
  );
}

/** The server page for each {@link ServerState}. */
export function ServerView({
  state,
  databaseVersion,
  mediaUrl,
  databaseUrl,
  now,
}: {
  readonly state: ServerState;
  /** The core's version, once known. */
  readonly databaseVersion: string | null;
  readonly mediaUrl: string;
  readonly databaseUrl: string;
  readonly now: number;
}) {
  const health = healthOf(state, now);

  return (
    <>
      <ServerHeader mediaUrl={mediaUrl} health={health} />
      <ServerBody
        state={state}
        health={health}
        databaseVersion={databaseVersion}
        mediaUrl={mediaUrl}
        databaseUrl={databaseUrl}
        now={now}
      />
    </>
  );
}

/** What the server page shows under its header for each {@link ServerState}. */
function ServerBody({
  state,
  health,
  databaseVersion,
  mediaUrl,
  databaseUrl,
  now,
}: {
  readonly state: ServerState;
  readonly health: Health;
  readonly databaseVersion: string | null;
  readonly mediaUrl: string;
  readonly databaseUrl: string;
  readonly now: number;
}) {
  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => <ReportsSkeleton />,
      failed: ({ message, retry }) => <Failed message={message} retry={retry} />,
      ready: ({ status }) => (
        <Reports
          status={status}
          health={health}
          databaseVersion={databaseVersion}
          mediaUrl={mediaUrl}
          databaseUrl={databaseUrl}
          now={now}
        />
      ),
    }),
  );
}

function Reports({
  status,
  health,
  databaseVersion,
  mediaUrl,
  databaseUrl,
  now,
}: {
  readonly status: ServerStatus;
  readonly health: Health;
  readonly databaseVersion: string | null;
  readonly mediaUrl: string;
  readonly databaseUrl: string;
  readonly now: number;
}) {
  const live = health === "up" ? status : null;

  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-body/body font-semibold text-text">Hardware transcoding</h2>
          <HardwareBadge transcoding={live?.transcoding ?? null} />
        </div>
        {status === null ? null : <Transcoder transcoding={status.transcoding} now={now} />}
      </div>
      <dl className="flex flex-col">
        <Setting label="Playing now">{live === null ? "—" : String(live.activeStreams)}</Setting>
        <Setting label="Streams stopping">
          {live === null ? "—" : String(live.runsAwaitingExit)}
        </Setting>
        <Setting label="Media service">
          {status === null ? mediaUrl : `${mediaUrl} · ${status.version}`}
        </Setting>
        <Setting label="Running since">
          {status === null ? "—" : formatTime(status.startedAt)}
        </Setting>
        <Setting label="Last report">
          {status === null ? "—" : formatTime(status.reportedAt)}
        </Setting>
        <Setting label="Database">
          {databaseVersion === null ? databaseUrl : `${databaseUrl} · ${databaseVersion}`}
        </Setting>
      </dl>
    </>
  );
}

/**
 * Each GPU, one line per render node, with the APIs ffmpeg opened it through and its userspace
 * driver, then how many capabilities are verified and unsupported and which are quarantined now.
 * The full list is the CLI's (`media admin server status`).
 */
function Transcoder({
  transcoding,
  now,
}: {
  readonly transcoding: Transcoding;
  readonly now: number;
}) {
  const devices = TranscodeLabels.devicesOf(transcoding.devices);
  const counts = TranscodeLabels.capabilityCounts(transcoding.capabilities, now);

  return (
    <div className="flex min-w-0 flex-col gap-0.5 font-mono text-caption/caption text-text-muted">
      {devices.length === 0 ? <p>CPU only</p> : null}
      {devices.map((device) => (
        <p key={device.node} className="truncate">
          {[
            device.label,
            device.apis.length === 0 ? "not opened" : device.apis.join(", "),
            device.driver,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
      ))}
      <p className="flex items-center gap-3">
        <Count icon={CircleCheck} count={counts.verified} label="verified" />
        <Count icon={CircleX} count={counts.unsupported} label="unsupported" />
        {counts.quarantined.length === 0 ? null : (
          <Count icon={CirclePause} count={counts.quarantined.length} label="quarantined" />
        )}
      </p>
      {counts.quarantined.map(({ key, endsAt }) => (
        <p key={key} className="flex items-center gap-1 truncate">
          <CirclePause aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          {`${key} · until ${endsAt === "restart" ? "restart" : formatTime(endsAt)}`}
        </p>
      ))}
    </div>
  );
}

function Count({
  icon: Icon,
  count,
  label,
}: {
  readonly icon: LucideIcon;
  readonly count: number;
  readonly label: string;
}) {
  return (
    <span className="flex items-center gap-1" title={label}>
      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {count}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Detected when ffmpeg opened a GPU, not detected when none, unknown while nothing reports. */
function HardwareBadge({ transcoding }: { readonly transcoding: Transcoding | null }) {
  const detected = transcoding?.devices.some((device) => device.opened) === true;
  const unknown = transcoding === null;

  return (
    <span
      className={cn(
        "flex h-5 items-center gap-1.25 rounded-pill px-1.75 font-sans text-caption/caption font-semibold",
        detected
          ? "bg-success/14 text-success"
          : unknown
            ? "bg-danger/14 text-danger"
            : "bg-text/10 text-text-muted",
      )}
    >
      <span aria-hidden className="size-1.25 rounded-pill bg-current" />
      {detected ? "Detected" : unknown ? "Unknown" : "Not detected"}
    </span>
  );
}

function Setting({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-6">
      <dt className="shrink-0 font-sans text-label/label font-medium text-text">{label}</dt>
      <dd className="truncate font-mono text-caption/caption text-text">{children}</dd>
    </div>
  );
}
