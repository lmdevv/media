import { HealthResponse, MEDIA_ROUTES } from "@media/contracts/media-playback";
import { Skeleton } from "@media/ui/components/skeleton";
import { cn } from "@media/ui/lib/utils";
import { Option, Schema } from "effect";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ENV, MEDIA_BASE_URL } from "@/env";

import { PageHeader } from "./page-header";

const decodeHealth = Schema.decodeUnknownOption(HealthResponse);

const POLL_MS = 10_000;

type Health =
  | { readonly status: "loading" }
  | { readonly status: "up"; readonly health: HealthResponse }
  | { readonly status: "down" };

const useMediaHealth = (): Health => {
  const [state, setState] = useState<Health>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    const check = async (): Promise<void> => {
      try {
        const response = await fetch(`${MEDIA_BASE_URL}${MEDIA_ROUTES.health}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });

        const decoded = response.ok ? decodeHealth(await response.json()) : Option.none();

        setState(
          Option.match(decoded, {
            onNone: (): Health => ({ status: "down" }),
            onSome: (value): Health => ({ status: "up", health: value }),
          }),
        );
      } catch {
        if (!controller.signal.aborted) setState({ status: "down" });
      }
    };

    void check();

    const timer = window.setInterval(() => void check(), POLL_MS);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return state;
};

const HEALTH_LABELS: Readonly<Record<Health["status"], string>> = {
  loading: "checking…",
  up: "media service running",
  down: "media service not responding",
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Server: the media service's health, hardware transcoding, live streams, and where it runs. */
export function ServerScreen() {
  const health = useMediaHealth();

  return (
    <>
      <PageHeader
        title="Server"
        facts={
          <span className="font-sans text-label/label">
            {hostOf(MEDIA_BASE_URL)} · {HEALTH_LABELS[health.status]}
          </span>
        }
      />
      {health.status === "loading" ? (
        <Skeleton className="h-28 w-full rounded-control" />
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <h2 className="font-sans text-body/body font-semibold text-text">
                Hardware transcoding
              </h2>
              <HardwareBadge health={health} />
            </div>
            <p className="font-mono text-caption/caption text-text-muted">
              {health.status === "up" && health.health.hardwareAcceleration === "qsv"
                ? "Intel Quick Sync"
                : "Software encoding with ffmpeg"}
            </p>
          </div>
          <dl className="flex flex-col">
            <Setting label="Playing now">
              {health.status === "up" ? String(health.health.activeStreams) : "—"}
            </Setting>
            <Setting label="Media service">{MEDIA_BASE_URL}</Setting>
            <Setting label="Database">{ENV.VITE_CONVEX_URL}</Setting>
          </dl>
        </>
      )}
    </>
  );
}

function HardwareBadge({ health }: { readonly health: Health }) {
  const detected = health.status === "up" && health.health.hardwareAcceleration === "qsv";
  const down = health.status === "down";

  return (
    <span
      className={cn(
        "flex h-5 items-center gap-1.25 rounded-pill px-1.75 font-sans text-caption/caption font-semibold",
        detected
          ? "bg-success/14 text-success"
          : down
            ? "bg-danger/14 text-danger"
            : "bg-text/10 text-text-muted",
      )}
    >
      <span aria-hidden className="size-1.25 rounded-pill bg-current" />
      {detected ? "Detected" : down ? "Unknown" : "Not detected"}
    </span>
  );
}

function Setting({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-6">
      <dt className="font-sans text-label/label font-medium text-text">{label}</dt>
      <dd className="truncate font-mono text-caption/caption text-text">{children}</dd>
    </div>
  );
}
