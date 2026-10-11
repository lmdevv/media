import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRun } from "@music/sdk/react";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { XIcon } from "lucide-react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { useAction } from "@/lib/action";
import { formatDuration } from "@/lib/format";

import { perform } from "./controls";

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
export function QueueRow({
  track,
  index,
  tone = "plain",
  current = false,
}: {
  readonly track: Track;
  readonly index: number;
  readonly tone?: "plain" | "glass";
  readonly current?: boolean;
}) {
  const player = usePlayer();
  const glass = tone === "glass";

  return (
    <div
      className={cn(
        "group/queue relative flex shrink-0 items-center gap-3 rounded-sm px-2",
        glass ? "gap-3.5 rounded-md px-3 py-2 hover:bg-text/8" : "hover:bg-surface",
        !glass && (current ? "h-row-touch bg-surface" : "h-[52px]"),
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
        className={cn(glass ? "size-11 rounded-sm" : "size-row rounded-[4px]")}
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
          <Tooltip label="Remove from queue">
            <button
              type="button"
              aria-label={`Remove ${track.title} from the queue`}
              onClick={() => perform(player.removeFromQueue(index))}
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
        </>
      )}
    </div>
  );
}

/** The desktop queue panel from Paper (02 Queue panel), beside the main column. */
export function QueuePanel() {
  const { setQueueOpen } = useUi();
  const { current, next, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  return (
    <aside
      aria-label="Queue"
      className="hidden w-[340px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-bg px-4 py-6 lg:flex dark:rounded-md dark:border-transparent"
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
        {next.length === 0 ? (
          <p className="px-2 py-1 font-sans text-sm/sm text-text-muted">
            Nothing after this song. Use “Play next” or “Add to queue” on any song.
          </p>
        ) : (
          next.map((entry) => (
            <QueueRow
              key={`${entry.index}-${entry.track.id}`}
              track={entry.track}
              index={entry.index}
            />
          ))
        )}
      </div>
    </aside>
  );
}
