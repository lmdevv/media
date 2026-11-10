import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Skeleton } from "@media/ui/components/skeleton";
import { describeFailure } from "@media/ui/lib/failure";
import { cn } from "@media/ui/lib/utils";
import { Match } from "effect";
import type { ReactNode } from "react";

import { PageHeader } from "@media/ui/components/page-header";

import { useNow } from "./now";
import { Failed, formatTime } from "./parts";
import type { ServerStatus } from "./types";

/**
 * The media server reports itself every five minutes while nothing changes; two missed reports
 * mean it stopped.
 */
const STALE_MS = 10 * 60 * 1000;

const NOW_EVERY_MS = 30_000;

type Reported = NonNullable<ServerStatus>;

type Acceleration = Reported["hardwareAcceleration"];

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

const ENCODER_LABELS: Readonly<Record<Acceleration, string>> = {
  qsv: "Intel Quick Sync",
  vaapi: "VA-API",
  none: "Software encoding with ffmpeg",
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Server: whether the media service runs, its hardware transcoding, its streams, and where. */
export function ServerScreen({
  mediaUrl,
  databaseUrl,
}: {
  /** The media server's address. */
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
      <PageHeader
        title="Server"
        facts={
          <span className="font-sans text-label/label">
            {hostOf(mediaUrl)} · {HEALTH_LABELS[health]}
          </span>
        }
      />
      {Match.value(state).pipe(
        Match.discriminatorsExhaustive("kind")({
          loading: () => <Skeleton aria-label="Loading" className="h-28 w-full rounded-control" />,
          failed: ({ message, retry }) => <Failed message={message} retry={retry} />,
          ready: ({ status }) => (
            <Reports
              status={status}
              health={health}
              databaseVersion={databaseVersion}
              mediaUrl={mediaUrl}
              databaseUrl={databaseUrl}
            />
          ),
        }),
      )}
    </>
  );
}

function Reports({
  status,
  health,
  databaseVersion,
  mediaUrl,
  databaseUrl,
}: {
  readonly status: ServerStatus;
  readonly health: Health;
  readonly databaseVersion: string | null;
  readonly mediaUrl: string;
  readonly databaseUrl: string;
}) {
  const live = health === "up" ? status : null;

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-body/body font-semibold text-text">Hardware transcoding</h2>
          <HardwareBadge acceleration={live?.hardwareAcceleration ?? null} />
        </div>
        <p className="font-mono text-caption/caption text-text-muted">
          {ENCODER_LABELS[status?.hardwareAcceleration ?? "none"]}
        </p>
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

/** Detected, not detected, or unknown while the media service does not report. */
function HardwareBadge({ acceleration }: { readonly acceleration: Acceleration | null }) {
  const detected = acceleration !== null && acceleration !== "none";
  const unknown = acceleration === null;

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
