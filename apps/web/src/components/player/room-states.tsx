import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { PlayGlyph } from "@media/ui/components/icons";
import { ProgressRing } from "@media/ui/components/progress-ring";
import { Wordmark } from "@media/ui/components/wordmark";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import { CopyIcon, EyeOffIcon, HouseIcon, Link2Icon, Link2OffIcon } from "lucide-react";
import type { ReactNode } from "react";

const timecode = (ms: number): string => formatTimecode(ms / 1000);

/**
 * Paper 08 · 01: the room's link to copy, then Start room. The room exists as soon as the dialog
 * opens, so the link works before it starts; Cancel ends it.
 */
export function StartRoomDialog({
  open,
  link,
  container,
  onCopy,
  onCancel,
  onStart,
}: {
  readonly open: boolean;
  /** The invite link, or null while the room is being created. */
  readonly link: string | null;
  /** Where the dialog renders, such as the player while it is full screen; the body when null. */
  readonly container: HTMLElement | null;
  readonly onCopy: () => void;
  readonly onCancel: () => void;
  readonly onStart: () => void;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {/* A null container renders nothing; undefined renders into the body. */}
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="on-media fixed top-1/2 left-1/2 z-50 flex w-dialog max-w-[calc(100vw-var(--spacing-8))] -translate-1/2 flex-col gap-7 rounded-card border border-hairline bg-dark-surface p-8 font-sans text-text shadow-overlay transition-[opacity,scale] duration-150 outline-none data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0">
          <DialogPrimitive.Title className="text-title/title font-heavy tracking-tight">
            Watch together
          </DialogPrimitive.Title>
          <div className="flex h-12 shrink-0 items-center gap-2 rounded-control bg-dark-bg pr-1.5 pl-4">
            <Link2Icon className="size-4 text-text-muted" strokeWidth={1.75} aria-hidden />
            <span
              aria-label="Room link"
              className="grow basis-0 truncate font-mono text-label/caption text-text"
            >
              {link ?? "…"}
            </span>
            <button
              type="button"
              disabled={link === null}
              onClick={onCopy}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded-inner bg-text/10 px-3 text-label/caption font-semibold transition-colors hover:bg-text/15 disabled:opacity-(--opacity-disabled)"
            >
              <CopyIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
              Copy
            </button>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="md"
              className="px-4.5 text-label/caption"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              size="md"
              className="px-5.5 text-body/label"
              disabled={link === null}
              onClick={onStart}
            >
              Start room
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The chip beside the back button: live, or paused for everyone. */
export function RoomChip({
  paused,
  watching,
  className,
}: {
  readonly paused: boolean;
  /** How many are watching; omitted after the host left. */
  readonly watching?: number | undefined;
  readonly className?: string;
}) {
  const label = [
    paused ? "Room paused" : "Live",
    watching === undefined ? null : `${String(watching)} watching`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <span
      data-slot="room-chip"
      className={cn(
        "flex h-7 shrink-0 items-center gap-2 rounded-pill pr-3 pl-2.5 font-sans text-caption/caption font-bold tracking-caps text-on-accent uppercase",
        paused ? "bg-text/18" : "bg-accent",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.75 shrink-0 rounded-pill", paused ? "bg-warning" : "bg-on-accent")}
      />
      {label}
    </span>
  );
}

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
        "on-media absolute inset-0 flex flex-col items-center justify-center gap-5 px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Paper 08 · 03: a guest catching up to the host. When the browser wants a click before it plays,
 * a Join button gives it one.
 */
export function SyncingToHost({
  hostName,
  targetMs,
  progress,
  onJoin,
}: {
  readonly hostName: string;
  readonly targetMs: number;
  readonly progress: number;
  /** Shown when the browser blocks playback until the viewer clicks. */
  readonly onJoin?: (() => void) | undefined;
}) {
  return (
    <Layer className="bg-dark-bg/60">
      <ProgressRing value={progress} className="size-14 text-text" label="Syncing" />
      <p className="text-center font-sans text-heading/heading font-bold text-text">
        Syncing to {hostName} · {timecode(targetMs)}
      </p>
      {onJoin === undefined ? null : (
        <Button size="md" className="text-body/label" autoFocus onClick={onJoin}>
          <PlayGlyph />
          Join
        </Button>
      )}
    </Layer>
  );
}

/** Paper 08 · 05: the host's connection froze the room for everyone. */
export function WaitingForHost({ hostName }: { readonly hostName: string }) {
  return (
    <Layer className="bg-dark-bg/60">
      <ProgressRing
        value={0.26}
        tone="text"
        spinning
        className="size-14 text-text"
        label="Waiting"
      />
      <p className="text-center font-sans text-heading/heading font-bold text-text">
        Waiting for {hostName}'s connection
      </p>
    </Layer>
  );
}

/** Paper 08 · 06: the host left; keep watching alone or leave. */
export function HostLeft({
  hostName,
  positionMs,
  onKeepWatching,
  onLeave,
}: {
  readonly hostName: string;
  readonly positionMs: number;
  readonly onKeepWatching: () => void;
  readonly onLeave: () => void;
}) {
  return (
    <Layer className="bg-dark-bg/72">
      <div className="flex w-120 max-w-full flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="font-sans text-title/title font-heavy tracking-tight text-text">
            {hostName} left the room
          </h2>
          <p className="font-sans text-body/body text-text-muted">
            Paused for everyone at {timecode(positionMs)}.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button
            variant="inverse"
            size="lg"
            className="text-body/label"
            autoFocus
            onClick={onKeepWatching}
          >
            <PlayGlyph />
            Keep watching on my own
          </Button>
          <Button variant="secondary" size="lg" className="text-body/label" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </div>
    </Layer>
  );
}

/** Why a room link cannot be joined, or the room cannot be watched on this profile now. */
export type RoomDenial =
  | { readonly kind: "ended"; readonly hostName: string }
  /** The active profile cannot see the room's title; `hostName` when the room could be read. */
  | { readonly kind: "household"; readonly hostName: string | null }
  /**
   * The room moved on to something the profile it joined with may not watch. The device keeps its
   * place, and the player comes back once the room plays something the profile may watch.
   */
  | { readonly kind: "unavailable"; readonly hostName: null };

/**
 * Paper 08 · 07a and 07b: a room link that cannot be joined, on its own page. The unavailable
 * state, a room that moved on out of this profile's reach, is not in Paper yet.
 */
export function RoomDenied({
  denial,
  home,
  switchProfile,
}: {
  readonly denial: RoomDenial;
  /** The Go to Home link, rendered by the router. */
  readonly home: (className: string) => ReactNode;
  readonly switchProfile: () => void;
}) {
  const ended = denial.kind === "ended";
  const unavailable = denial.kind === "unavailable";
  const owner = denial.hostName === null ? null : `${denial.hostName}'s`;

  return (
    <div className="on-media flex min-h-svh flex-col bg-dark-bg bg-radial-[ellipse_60%_50%_at_50%_0%] from-dark-warning/10 to-transparent px-6 pt-4 md:px-16">
      <div className="flex h-17 shrink-0 items-center">
        <Wordmark />
      </div>
      <main className="flex grow items-center justify-center pb-21">
        <div className="flex w-130 max-w-full flex-col items-center gap-7">
          <span className="flex size-16 items-center justify-center rounded-pill bg-dark-surface-raised">
            {ended ? (
              <Link2OffIcon className="size-7 text-text" strokeWidth={1.75} aria-hidden />
            ) : unavailable ? (
              <EyeOffIcon className="size-7 text-text" strokeWidth={1.75} aria-hidden />
            ) : (
              <HouseIcon className="size-7 text-text" strokeWidth={1.75} aria-hidden />
            )}
          </span>
          <div className="flex flex-col items-center gap-2.5 text-center">
            <h1 className="font-sans text-title/title font-heavy tracking-tight text-text">
              {ended
                ? "This room has ended"
                : unavailable
                  ? "Not available on this profile"
                  : `This room is for ${owner ?? "another"} household`}
            </h1>
            <p className="font-sans text-body/body text-text-muted">
              {denial.kind === "ended"
                ? `${denial.hostName} closed this room. Ask ${denial.hostName} for a new invite.`
                : unavailable
                  ? "The room moved on to something this profile can't watch. You keep your place, and the player comes back when the room plays something you can."
                  : `Switch to a profile on ${owner ?? "this"} server to join.`}
            </p>
          </div>
          <div className="flex gap-3">
            {ended ? null : (
              <Button
                variant="inverse"
                size="md"
                className="text-body/label"
                onClick={switchProfile}
              >
                Switch profile
              </Button>
            )}
            {home(
              cn(
                ended
                  ? buttonVariants({ variant: "inverse", size: "md" })
                  : buttonVariants({ variant: "ghost", size: "md" }),
                "text-body/label",
              ),
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
