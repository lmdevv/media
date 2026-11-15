import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@media/ui/components/button";
import { PlayGlyph } from "@media/ui/components/icons";
import { ProgressRing } from "@media/ui/components/progress-ring";
import { Wordmark } from "@media/ui/components/wordmark";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import {
  CopyIcon,
  EyeOffIcon,
  HourglassIcon,
  Link2Icon,
  Link2OffIcon,
  LockIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Match } from "effect";
import type { ReactNode } from "react";

const timecode = (ms: number): string => formatTimecode(ms / 1000);

/**
 * Paper 08 · 01: the session's link to copy, then Start. The session exists as soon as the dialog
 * opens, so the link works before it starts; Cancel ends it.
 */
export function StartSessionDialog({
  open,
  link,
  container,
  onCopy,
  onCancel,
  onStart,
}: {
  readonly open: boolean;
  /** The join link's web address, or null while the session is being created. */
  readonly link: string | null;
  /** Where the dialog renders, such as the player while it is full screen. */
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
              aria-label="Session link"
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
              Start session
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The chip beside the back button: live, or paused for everyone. */
export function SessionChip({
  paused,
  watching,
  className,
}: {
  readonly paused: boolean;
  /** How many are in the session. */
  readonly watching: number;
  readonly className?: string;
}) {
  return (
    <span
      data-slot="session-chip"
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
      {`${paused ? "Session paused" : "Live"} · ${String(watching)} watching`}
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
 * Paper 08 · 03: a member catching up to the session. When the browser wants a click before it
 * plays, a Join button gives it one.
 */
export function SyncingToSession({
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

/** Paper 08 · 06: the host went away, so the session waits for them; go on alone or leave. */
export function HostAway({
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
            {hostName} left the session
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
            Leave session
          </Button>
        </div>
      </div>
    </Layer>
  );
}

/** The session the player followed ended or took the viewer out; go on alone or go back. */
export function SessionStopped({
  title,
  onKeepWatching,
  onBack,
}: {
  readonly title: string;
  readonly onKeepWatching: () => void;
  readonly onBack: () => void;
}) {
  return (
    <Layer className="bg-dark-bg/72">
      <div className="flex w-120 max-w-full flex-col items-center gap-6">
        <h2 className="text-center font-sans text-title/title font-heavy tracking-tight text-text">
          {title}
        </h2>
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
          <Button variant="secondary" size="lg" className="text-body/label" onClick={onBack}>
            Back to details
          </Button>
        </div>
      </div>
    </Layer>
  );
}

/** Why the session page shows no player. */
export type SessionNotice =
  /** The link opens no session, or the person cannot join it: `message` says which. */
  | { readonly kind: "refused"; readonly message: string }
  /** The session is locked and takes no one new. */
  | { readonly kind: "locked" }
  | { readonly kind: "ended"; readonly hostName: string | null }
  /** Waiting for the host to let the person in. */
  | { readonly kind: "waiting"; readonly hostName: string }
  /** The session plays something the person may not watch; they keep their place. */
  | { readonly kind: "unavailable" };

const NOTICE_ICONS = {
  refused: Link2OffIcon,
  ended: Link2OffIcon,
  locked: LockIcon,
  waiting: HourglassIcon,
  unavailable: EyeOffIcon,
} as const satisfies Record<SessionNotice["kind"], LucideIcon>;

/** What the session page says about a notice. */
interface NoticeText {
  readonly title: string;
  readonly body: string;
}

const endedBody = (hostName: string | null): string =>
  hostName === null
    ? "Ask for a new link."
    : `${hostName} ended this session. Ask ${hostName} for a new link.`;

const noticeText = (notice: SessionNotice): NoticeText =>
  Match.value(notice).pipe(
    Match.discriminatorsExhaustive("kind")({
      refused: ({ message }): NoticeText => ({ title: "Can't join this session", body: message }),
      locked: (): NoticeText => ({
        title: "This session is locked",
        body: "The host isn't letting anyone new in. Ask them to open it.",
      }),
      ended: ({ hostName }): NoticeText => ({
        title: "This session has ended",
        body: endedBody(hostName),
      }),
      waiting: ({ hostName }): NoticeText => ({
        title: `Waiting for ${hostName}`,
        body: `You join as soon as ${hostName} lets you in.`,
      }),
      unavailable: (): NoticeText => ({
        title: "Not available on this profile",
        body: "The session plays something you can't watch. You keep your place, and the player comes back when the session plays something you can.",
      }),
    }),
  );

/**
 * Paper 08 · 07: the session page without a player: a link that cannot be joined, waiting for the
 * host, or a session playing something the person may not watch.
 */
export function SessionPage({
  notice,
  home,
  onLeave,
}: {
  readonly notice: SessionNotice;
  /** The Go to Home link, rendered by the router. */
  readonly home: (className: string) => ReactNode;
  /** Leaves the session the person waits for or keeps a place in; omit where they hold none. */
  readonly onLeave?: (() => void) | undefined;
}) {
  const { title, body } = noticeText(notice);
  const Icon = NOTICE_ICONS[notice.kind];

  return (
    <div className="on-media flex min-h-svh flex-col bg-dark-bg bg-radial-[ellipse_60%_50%_at_50%_0%] from-dark-warning/10 to-transparent px-6 pt-4 md:px-16">
      <div className="flex h-17 shrink-0 items-center">
        <Wordmark />
      </div>
      <main className="flex grow items-center justify-center pb-21">
        <div className="flex w-130 max-w-full flex-col items-center gap-7">
          <span className="flex size-16 items-center justify-center rounded-pill bg-dark-surface-raised">
            <Icon className="size-7 text-text" strokeWidth={1.75} aria-hidden />
          </span>
          <div className="flex flex-col items-center gap-2.5 text-center">
            <h1 className="font-sans text-title/title font-heavy tracking-tight text-text">
              {title}
            </h1>
            <p className="font-sans text-body/body text-text-muted">{body}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            {onLeave === undefined ? null : (
              <Button variant="inverse" size="md" className="text-body/label" onClick={onLeave}>
                Leave session
              </Button>
            )}
            {home(
              cn(
                buttonVariants({
                  variant: onLeave === undefined ? "inverse" : "ghost",
                  size: "md",
                }),
                "text-body/label",
              ),
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
