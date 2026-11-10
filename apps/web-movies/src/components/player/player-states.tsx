import { Button } from "@media/ui/components/button";
import { PlayGlyph } from "@media/ui/components/icons";
import { ProgressRing } from "@media/ui/components/progress-ring";
import { Spinner } from "@media/ui/components/spinner";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import { CaptionsIcon, FileXIcon, FlagIcon, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";

const timecode = (ms: number): string => formatTimecode(ms / 1000);

function Layer({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "on-media absolute inset-0 flex flex-col items-center justify-center px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Paper 04: welcome back, with where the person stopped, and resume or start over. */
export function ResumePrompt({
  titleLabel,
  personName,
  positionMs,
  durationMs,
  onResume,
  onStartOver,
}: {
  readonly titleLabel: string;
  readonly personName: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly onResume: () => void;
  readonly onStartOver: () => void;
}) {
  const fraction = durationMs <= 0 ? 0 : Math.min(1, positionMs / durationMs);

  return (
    <div className="on-media absolute inset-0 flex flex-col justify-end bg-linear-to-r from-dark-bg/82 via-dark-bg/55 to-dark-bg/15 px-6 pb-16 md:px-24 md:pb-28">
      <div className="flex w-full max-w-dialog flex-col gap-7">
        <div className="flex flex-col gap-2">
          <p className="font-sans text-label/label font-semibold tracking-caps text-text-muted uppercase">
            {titleLabel}
          </p>
          <h1 className="font-sans text-title/title font-heavy tracking-display text-text md:text-display/display">
            Welcome back, {personName}
          </h1>
        </div>
        <div className="flex w-full max-w-110 items-center gap-4">
          <div className="flex h-1 grow rounded-bar bg-text/25">
            <div
              className="h-1 rounded-bar bg-accent"
              style={{ width: `${String(fraction * 100)}%` }}
            />
          </div>
          <span className="font-mono text-label/caption text-text-muted">
            {timecode(positionMs)} / {timecode(durationMs)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" className="h-13 text-button/5" autoFocus onClick={onResume}>
            <PlayGlyph />
            Resume from {timecode(positionMs)}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            className="h-13 text-button/5"
            onClick={onStartOver}
          >
            <RotateCcwIcon strokeWidth={1.75} aria-hidden />
            Start from beginning
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Paper 07: negotiating and loading a stream, with where it will start. */
export function PreparingStream({
  titleLabel,
  startAtMs,
  progress,
}: {
  readonly titleLabel: string;
  readonly startAtMs: number;
  readonly progress: number;
}) {
  return (
    <Layer className="gap-8 bg-dark-bg/78 motion-safe:animate-in motion-safe:fade-in motion-safe:delay-200 motion-safe:fill-mode-backwards">
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        <p className="font-sans text-label/label font-semibold tracking-caps text-text-muted uppercase">
          {titleLabel}
        </p>
        <h2 className="font-sans text-title/title font-heavy tracking-tight text-text">
          Preparing your stream
        </h2>
      </div>
      <div className="flex w-90 max-w-full flex-col gap-3">
        <div
          role="progressbar"
          aria-label="Preparing your stream"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="flex h-0.75 shrink-0 rounded-bar bg-text/15"
        >
          <div
            className="h-0.75 rounded-bar bg-accent transition-[width] duration-700 ease-out"
            style={{ width: `${String(progress * 100)}%` }}
          />
        </div>
        {startAtMs <= 0 ? null : (
          <p className="text-center font-mono text-caption/caption text-text-muted">
            Starting at {timecode(startAtMs)}
          </p>
        )}
      </div>
    </Layer>
  );
}

/** Paper 06: the stream stalled; the ring fills as the buffer refills. */
export function Buffering({ fraction }: { readonly fraction: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);

  return (
    <Layer className="pointer-events-none gap-4 bg-dark-bg/35">
      <ProgressRing value={fraction} label="Buffering" className="text-text" />
      <span className="font-mono text-label/caption text-text">{percent}%</span>
    </Layer>
  );
}

/** Paper 08: a path failed and the player negotiates the next one. */
export function TryingAnotherWay({
  positionMs,
  onBack,
}: {
  readonly positionMs: number;
  readonly onBack: () => void;
}) {
  return (
    <Layer className="bg-dark-bg/78">
      <div className="flex w-130 max-w-full flex-col items-center gap-8">
        <Spinner className="size-12 text-text" label="Trying another way to play" />
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="font-sans text-title/title font-heavy tracking-tight text-text">
            Trying another way to play
          </h2>
          <p className="font-sans text-body/body text-text-muted">
            Resuming at {timecode(positionMs)}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="text-label/caption" onClick={onBack}>
          Back to details
        </Button>
      </div>
    </Layer>
  );
}

/**
 * Paper 09: a calm stop. `missing` is the file that was moved or went offline; other stops say
 * what happened in `title` and `description`.
 */
export function PlaybackStopped({
  missing,
  title,
  description,
  onBack,
  secondary,
}: {
  readonly missing: boolean;
  readonly title: string;
  readonly description: string;
  readonly onBack: () => void;
  /** A second action, such as Report to admin or Try again. */
  readonly secondary?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <Layer className="bg-dark-bg/88">
      <div className="flex w-dialog max-w-full flex-col gap-7">
        {missing ? <FileXIcon className="size-10 text-text" strokeWidth={1.5} aria-hidden /> : null}
        <div className="flex flex-col gap-2.5">
          <h2 className="font-sans text-title/title font-heavy tracking-tight text-text">
            {title}
          </h2>
          <p className="font-sans text-body/body text-text-muted">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="inverse"
            size="md"
            className="text-body/label"
            autoFocus
            onClick={onBack}
          >
            Back to details
          </Button>
          {secondary === undefined ? null : (
            <Button
              variant="secondary"
              size="md"
              className="text-body/label"
              onClick={secondary.onClick}
            >
              {missing ? <FlagIcon strokeWidth={1.75} aria-hidden /> : null}
              {secondary.label}
            </Button>
          )}
        </div>
      </div>
    </Layer>
  );
}

/** The browser wants a click before it plays; one big play button gives it one. */
export function PressPlay({ onPlay }: { readonly onPlay: () => void }) {
  return (
    <Layer className="bg-dark-bg/35">
      <button
        type="button"
        aria-label="Play"
        onClick={onPlay}
        className="flex size-18 cursor-pointer items-center justify-center rounded-pill bg-dark-bg/55 text-text transition-colors hover:bg-dark-bg/75 [&_svg]:size-8"
      >
        <PlayGlyph />
      </button>
    </Layer>
  );
}

/**
 * A moment's notice at the top of the frame after G or H, or a command, moved the subtitle delay:
 * the delay now, such as `+0.5 s`, or why it cannot apply. The live region stays mounted and only
 * its content comes and goes, so screen readers announce each change.
 */
export function SubtitleDelayNotice({ text }: { readonly text: string | null }) {
  return (
    <div
      role="status"
      className="on-media pointer-events-none absolute top-8 left-1/2 -translate-x-1/2"
    >
      {text === null ? null : (
        <div className="flex h-10 items-center gap-2 rounded-pill border border-text/10 bg-glass px-4 font-sans text-label/label text-text shadow-glass backdrop-blur-xl [&_svg]:size-4">
          <CaptionsIcon strokeWidth={1.75} aria-hidden />
          <span className="text-text-muted">Subtitle delay</span>
          <span className="font-semibold tabular-nums">{text}</span>
        </div>
      )}
    </div>
  );
}
