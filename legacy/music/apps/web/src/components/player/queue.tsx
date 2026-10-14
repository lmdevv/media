import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRun } from "@music/sdk/react";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { useAction } from "@/lib/action";
import { formatDuration } from "@/lib/format";

import { perform } from "./controls";
import { focusMove } from "./queue-focus";
import type { LandedRemoval } from "./queue-focus";

/** The current song and the songs after it. */
export interface UpNext {
  readonly current: Track | null;
  /** Songs after the current one with their queue positions, for jump and remove. */
  readonly next: ReadonlyArray<{ readonly track: Track; readonly index: number }>;
  /** The album every upcoming song shares, or null for a mixed queue. */
  readonly source: string | null;
}

/** The songs after the current one, with their queue positions. */
export const useUpNext = (): UpNext => {
  const player = usePlayer();

  const next = player.queue
    .slice(player.index + 1)
    .map((track, offset) => ({ track, index: player.index + 1 + offset }));

  const albums = new Set(next.map((entry) => entry.track.albumId));
  const source = albums.size === 1 ? (next[0]?.track.album ?? null) : null;

  return { current: player.track, next, source };
};

/** Clears everything after the current song. */
export const useClearQueue = () => {
  const clear = useRun("queue.clear");

  return useAction(() => clear({}), { success: () => "Cleared the queue" });
};

/**
 * One queued song. Click to play it; the remove button appears on hover or focus. `tone="glass"`
 * draws it for the art-tinted Now Playing background.
 */
function QueueRow({
  track,
  index,
  tone = "plain",
  current = false,
  onRemove,
}: {
  readonly track: Track;
  readonly index: number;
  readonly tone?: "plain" | "glass";
  readonly current?: boolean;
  /** Removes the song from the queue; a row without it has no remove button. */
  readonly onRemove?: () => void;
}) {
  const player = usePlayer();
  const glass = tone === "glass";

  return (
    <div
      className={cn(
        "group/queue relative flex shrink-0 items-center gap-3 rounded-sm px-2",
        glass ? "gap-3.5 rounded-md px-3 py-2 hover:bg-text/8" : "hover:bg-surface",
        !glass && (current ? "h-row-touch bg-surface" : "h-13"),
        glass && current && "bg-text/8",
      )}
    >
      <button
        type="button"
        aria-label={current ? `Now playing: ${track.title}` : `Play ${track.title}`}
        disabled={current}
        onClick={() => perform(player.jump(index))}
        className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <Artwork
        url={track.artUrl}
        seed={track.albumId}
        className={cn(glass ? "size-11 rounded-sm" : "size-row rounded-xs")}
      />
      <div className="pointer-events-none flex min-w-0 grow flex-col gap-px">
        <span
          className={cn(
            "truncate font-sans text-text",
            glass ? "text-md/base font-medium" : "text-base/sm",
            current && !glass && "font-semibold",
          )}
        >
          {track.title}
        </span>
        <span
          className={cn(
            "truncate font-sans text-sm/xs",
            glass ? "text-text/60" : "text-text-muted",
          )}
        >
          {track.artist}
        </span>
      </div>
      {current ? (
        <PlayingBars />
      ) : (
        <>
          {glass ? (
            <span className="font-mono text-xs/xs text-text/55 group-hover/queue:hidden">
              {formatDuration(track.durationMs)}
            </span>
          ) : null}
          {onRemove === undefined ? null : (
            <Tooltip label="Remove from queue">
              <button
                type="button"
                aria-label={`Remove ${track.title} from the queue`}
                data-queue-remove
                onClick={onRemove}
                className={cn(
                  "relative flex size-7 shrink-0 items-center justify-center rounded-full opacity-0 outline-none group-hover/queue:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
                  glass
                    ? "text-text/70 hover:bg-text/10"
                    : "text-text-muted hover:bg-border hover:text-text",
                )}
              >
                <XIcon className="size-4" />
              </button>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The upcoming songs as queue rows, or `empty` when there are none. Removing a row moves focus to
 * the row that takes its place, or to the new last row, instead of dropping it to the page
 * (ADS-107); with no rows left, the list itself takes focus.
 */
export function QueueList({
  next,
  empty,
  tone = "plain",
  className,
}: {
  readonly next: UpNext["next"];
  readonly empty: ReactNode;
  readonly tone?: "plain" | "glass";
  readonly className?: string;
}) {
  const player = usePlayer();
  const list = useRef<HTMLDivElement>(null);
  // Set once a removal has landed (a failure shows as the player error and sets nothing). The
  // queue can reach this view a render later, so focus moves when the list no longer shows it.
  const [removed, setRemoved] = useState<LandedRemoval | null>(null);
  const handled = useRef<LandedRemoval | null>(null);
  const trackIds = next.map((entry) => entry.track.id);
  const signature = trackIds.join(" ");

  useEffect(() => {
    const element = list.current;

    if (removed === null || handled.current === removed || element === null) return;

    const active = document.activeElement;
    // Inside Now Playing the dialog itself takes focus when the removed row's button unmounts, so
    // focus on that popup is free too; focus on any other control in it is the user's choice.
    const popup = element.closest("[role=dialog]");

    const move = focusMove(removed, {
      now: Date.now(),
      trackIds: signature.length === 0 ? [] : signature.split(" "),
      focusFree:
        active === null || active === document.body || active === popup || element.contains(active),
    });

    if (move === "wait") return;

    handled.current = removed;

    if (move === "drop") return;

    const buttons = element.querySelectorAll<HTMLElement>("[data-queue-remove]");

    (buttons[Math.min(removed.position, buttons.length - 1)] ?? element).focus();
  }, [removed, signature]);

  // One removal at a time: rows keep their old queue positions until the first one lands, so a
  // second click (a double-click, or a quick click on another row) would remove the wrong song.
  const removing = useRef(false);

  const removeAt = async (index: number, position: number, trackId: string): Promise<void> => {
    if (removing.current) return;

    removing.current = true;

    const countBefore = trackIds.filter((id) => id === trackId).length;

    try {
      if (await player.removeFromQueue(index)) {
        setRemoved({ position, trackId, countBefore, landedAt: Date.now() });
      }
    } finally {
      removing.current = false;
    }
  };

  return (
    <div ref={list} tabIndex={-1} className={cn("outline-none", className)}>
      {next.length === 0
        ? empty
        : next.map((entry, position) => (
            <QueueRow
              key={`${entry.index}-${entry.track.id}`}
              track={entry.track}
              index={entry.index}
              tone={tone}
              onRemove={() => void removeAt(entry.index, position, entry.track.id)}
            />
          ))}
    </div>
  );
}

/** The desktop queue panel from Paper (02 Queue panel), beside the main column. */
export function QueuePanel() {
  const { setQueueOpen } = useUi();
  const { current, next, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  // Esc closes the panel, unless a dialog or menu above it already handled the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (document.querySelector("[role=dialog], [role=menu], [role=listbox]") !== null) return;

      setQueueOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setQueueOpen]);

  return (
    <aside
      aria-label="Queue"
      className="hidden w-85 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-bg px-4 py-6 lg:flex dark:rounded-md dark:border-transparent"
    >
      <div className="flex items-center justify-between px-2">
        <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">Queue</h2>
        <button
          type="button"
          aria-label="Close the queue"
          onClick={() => setQueueOpen(false)}
          className="flex size-7 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text"
        >
          <XIcon className="size-5" />
        </button>
      </div>
      {current === null ? null : (
        <div className="flex flex-col gap-2">
          <span className="px-2 font-mono text-xs/xs tracking-mono text-text-muted">
            NOW PLAYING
          </span>
          <QueueRow track={current} index={-1} current />
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="truncate font-mono text-xs/xs tracking-mono text-text-muted uppercase">
            {source === null ? "Next up" : `Next from ${source}`}
          </span>
          {next.length > 0 ? (
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
              className="shrink-0 font-sans text-sm/xs font-medium text-text-muted hover:text-text disabled:opacity-(--opacity-muted)"
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          ) : null}
        </div>
        <QueueList
          next={next}
          className="flex flex-col gap-0.5"
          empty={
            <p className="px-2 py-1 font-sans text-sm/sm text-text-muted">
              Nothing after this song. Use “Play next” or “Add to queue” on any song.
            </p>
          }
        />
      </div>
    </aside>
  );
}
