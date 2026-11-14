import { usePlayer } from "@media/player/react";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useHotkey } from "@tanstack/react-hotkeys";
import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { MoveButtons, ReorderHandle, useReorder } from "@/components/library/reorder";
import type { Reorder } from "@/components/library/reorder";
import { useUi } from "@/components/shell/ui-state";
import { toastFailure, useAction } from "@/lib/action";
import { formatDuration } from "@/lib/format";
import { HOTKEYS } from "@/lib/hotkeys";
import type { QueueEntry, QueueItemId } from "@/lib/models";
import { useMusic } from "@/lib/platform";
import { dropLine } from "@/lib/reorder";

import { perform } from "./player-actions";
import { focusMove } from "./queue-focus";
import type { LandedRemoval } from "./queue-focus";

/** The current song and the entries after it. */
export interface UpNext {
  readonly current: QueueEntry | null;
  /** Entries people queued after the current one, in play order. */
  readonly queued: ReadonlyArray<QueueEntry>;
  /** Entries autoplay added after those. */
  readonly autoplay: ReadonlyArray<QueueEntry>;
  /** The album every queued song shares, or null for a mixed queue. */
  readonly source: string | null;
}

/** The entries after the current one, split into what people queued and what autoplay added. */
export const useUpNext = (): UpNext => {
  const player = usePlayer();
  const upcoming = player.queue.slice(player.index + 1);
  const queued = upcoming.filter((entry) => !entry.autoplay);
  const albums = new Set(queued.map((entry) => entry.albumId));
  const source = albums.size === 1 ? (queued[0]?.album ?? null) : null;

  return {
    current: player.track,
    queued,
    autoplay: upcoming.filter((entry) => entry.autoplay),
    source,
  };
};

/** Clears everything after the current song. */
export const useClearQueue = (): readonly [
  clear: () => Promise<null | undefined>,
  clearing: boolean,
] => {
  const clear = useMusic().queue.clear;

  return useAction(() => clear({}), { success: () => "Cleared the queue" });
};

type Tone = "plain" | "glass";

interface RowReorder {
  readonly index: number;
  readonly count: number;
  readonly reorder: Reorder;
  readonly mode: "drag" | "buttons";
}

function QueueRow({
  entry,
  tone = "plain",
  current = false,
  reorder,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly tone?: Tone;
  readonly current?: boolean;
  readonly reorder?: RowReorder;
  readonly onRemove?: () => void;
}) {
  const player = usePlayer();
  const glass = tone === "glass";
  const moveButtons = reorder?.mode === "buttons" ? reorder : null;
  const dragging = reorder?.mode === "drag" ? reorder : null;
  const drag = dragging === null ? {} : dragging.reorder.rowProps(dragging.index);

  return (
    <div
      data-testid="queue-row"
      {...drag}
      className={cn(
        queueRowClassName(glass, current),
        reorder === undefined ? null : dropLine(reorder.reorder.dropSide(reorder.index)),
      )}
    >
      <button
        type="button"
        aria-label={current ? `Now playing: ${entry.title}` : `Play ${entry.title}`}
        disabled={current || moveButtons !== null}
        onClick={() => perform(player.jump(entry.itemId))}
        className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      {dragging === null ? null : (
        <ReorderHandle
          label={entry.title}
          index={dragging.index}
          count={dragging.count}
          reorder={dragging.reorder}
          className={cn(
            "-mx-1.5 opacity-0 group-hover/queue:opacity-100 focus-visible:opacity-100",
            glass && "text-text/60",
          )}
        />
      )}
      <Artwork
        url={entry.artUrl}
        seed={entry.albumId}
        className={cn(glass ? "size-11 rounded-sm" : "size-row rounded-xs")}
      />
      <QueueRowText entry={entry} glass={glass} current={current} />
      <QueueRowEnd
        entry={entry}
        glass={glass}
        current={current}
        moveButtons={moveButtons}
        onRemove={onRemove}
      />
    </div>
  );
}

const queueRowClassName = (glass: boolean, current: boolean): string =>
  cn(
    "group/queue relative flex shrink-0 items-center gap-3 rounded-sm px-2",
    glass ? "gap-3.5 rounded-md px-3 py-2 hover:bg-text/8" : "hover:bg-surface",
    !glass && (current ? "h-row-touch bg-surface" : "h-13"),
    glass && current && "bg-text/8",
  );

function QueueRowText({
  entry,
  glass,
  current,
}: {
  readonly entry: QueueEntry;
  readonly glass: boolean;
  readonly current: boolean;
}) {
  return (
    <div className="pointer-events-none flex min-w-0 grow flex-col gap-px">
      <span
        className={cn(
          "truncate font-sans text-text",
          glass ? "text-md/base font-medium" : "text-base/sm",
          current && !glass && "font-semibold",
        )}
      >
        {entry.title}
      </span>
      <span
        className={cn("truncate font-sans text-sm/xs", glass ? "text-text/60" : "text-text-muted")}
      >
        {entry.artist}
      </span>
    </div>
  );
}

function QueueRowEnd({
  entry,
  glass,
  current,
  moveButtons,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly glass: boolean;
  readonly current: boolean;
  readonly moveButtons: RowReorder | null;
  readonly onRemove: (() => void) | undefined;
}) {
  if (current) return <PlayingBars />;

  if (moveButtons !== null) {
    return (
      <MoveButtons
        label={entry.title}
        index={moveButtons.index}
        count={moveButtons.count}
        reorder={moveButtons.reorder}
      />
    );
  }

  return (
    <>
      {glass ? (
        <span className="font-mono text-xs/xs text-text/55 group-hover/queue:hidden">
          {formatDuration(entry.durationMs)}
        </span>
      ) : null}
      {onRemove === undefined ? null : (
        <Tooltip label="Remove from queue">
          <button
            type="button"
            aria-label={`Remove ${entry.title} from the queue`}
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
  );
}

const useQueueRemoval = (entries: ReadonlyArray<QueueEntry>) => {
  const player = usePlayer();
  const list = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState<LandedRemoval | null>(null);
  const handled = useRef<LandedRemoval | null>(null);
  const signature = entries.map((entry) => entry.itemId).join(" ");

  useLayoutEffect(() => {
    const element = list.current;

    if (removed === null || handled.current === removed || element === null) return;

    const active = document.activeElement;

    const move = focusMove(removed, {
      now: Date.now(),
      trackIds: signature.length === 0 ? [] : signature.split(" "),
      focusFree: active === null || active === document.body || element.contains(active),
    });

    if (move === "wait") return;

    handled.current = removed;

    if (move === "drop") return;

    const buttons = element.querySelectorAll<HTMLElement>("[data-queue-remove]");

    (buttons[Math.min(removed.position, buttons.length - 1)] ?? element).focus();
  }, [removed, signature]);

  const removing = useRef(false);

  const remove = async (itemId: QueueItemId, position: number): Promise<void> => {
    if (removing.current) return;

    removing.current = true;

    try {
      if (await player.removeFromQueue(itemId)) {
        setRemoved({ position, trackId: itemId, countBefore: 1, landedAt: Date.now() });
      }
    } finally {
      removing.current = false;
    }
  };

  return { list, remove };
};

/**
 * The songs after the current one: what people queued, which can be dragged into a new order
 * (or moved with the arrow keys on the handle, or with up/down buttons in reorder mode), then
 * what autoplay added, under a toggle.
 */
export function UpcomingQueue({
  tone = "plain",
  heading,
  empty,
  reorderMode = false,
}: {
  readonly tone?: Tone;
  /** The heading above the queued songs, with any actions beside it. */
  readonly heading: ReactNode;
  /** Shown when nothing is queued. */
  readonly empty: ReactNode;
  /** Phones: show up/down buttons on each row instead of dragging. */
  readonly reorderMode?: boolean;
}) {
  const move = useMusic().queue.move;
  const { current, queued, autoplay } = useUpNext();
  const ids = queued.map((entry) => entry.itemId);
  const removal = useQueueRemoval(queued);

  const reorder = useReorder<QueueItemId>(
    ids,
    current?.itemId ?? null,
    async (itemId, afterItemId) => {
      try {
        await move(afterItemId === null ? { itemId } : { itemId, afterItemId });
      } catch (cause) {
        toastFailure(cause);
        throw cause;
      }
    },
  );

  return (
    <>
      <div className="flex flex-col gap-0.5">
        {heading}
        <div ref={removal.list} tabIndex={-1} className="flex flex-col gap-0.5 outline-none">
          {queued.length === 0
            ? empty
            : queued.map((entry, index) => (
                <QueueRow
                  key={entry.itemId}
                  entry={entry}
                  tone={tone}
                  onRemove={() => void removal.remove(entry.itemId, index)}
                  reorder={{
                    index,
                    count: queued.length,
                    reorder,
                    mode: reorderMode ? "buttons" : "drag",
                  }}
                />
              ))}
        </div>
      </div>
      <AutoplaySection tone={tone} entries={autoplay} />
    </>
  );
}

function AutoplaySection({
  tone,
  entries,
}: {
  readonly tone: Tone;
  readonly entries: ReadonlyArray<QueueEntry>;
}) {
  const player = usePlayer();
  const glass = tone === "glass";
  const removal = useQueueRemoval(entries);

  return (
    <section aria-label="Autoplay" className="flex flex-col gap-0.5">
      <div
        className={cn("flex items-center justify-between gap-3 pb-1.5", glass ? "px-3" : "px-2")}
      >
        <span
          className={cn(
            "truncate font-mono text-xs/xs tracking-mono uppercase",
            glass ? "text-text/55" : "text-text-muted",
          )}
        >
          Autoplay
        </span>
        <Switch
          aria-label="Autoplay"
          checked={player.autoplay}
          onCheckedChange={(on) => perform(player.setAutoplay(on))}
        />
      </div>
      {player.autoplay ? (
        <div ref={removal.list} tabIndex={-1} className="flex flex-col gap-0.5 outline-none">
          {entries.map((entry, index) => (
            <QueueRow
              key={entry.itemId}
              entry={entry}
              tone={tone}
              onRemove={() => void removal.remove(entry.itemId, index)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The desktop queue panel from Paper (02 Queue panel), beside the main column. */
export function QueuePanel() {
  const { setQueueOpen } = useUi();
  const { current, queued, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  // On window, after Base UI's document listeners, so an Escape that already closed one of its
  // popups (and so was prevented) leaves the panel open.
  useHotkey(
    HOTKEYS["queue.close"],
    (event) => {
      if (event.defaultPrevented) return;

      if (document.querySelector("[role=dialog], [role=menu], [role=listbox]") !== null) return;

      setQueueOpen(false);
    },
    { target: window, preventDefault: false },
  );

  return (
    <aside
      aria-label="Queue"
      className="hidden w-85 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-bg px-4 py-6 lg:flex dark:rounded-md dark:border-transparent"
    >
      <div className="flex items-center justify-between gap-2 px-2">
        <h2 className="grow font-sans text-lg/md font-semibold tracking-tight text-text">Queue</h2>
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
          <QueueRow entry={current} current />
        </div>
      )}
      <UpcomingQueue
        heading={
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="truncate font-mono text-xs/xs tracking-mono text-text-muted uppercase">
              {source === null ? "Next up" : `Next from ${source}`}
            </span>
            {queued.length > 0 ? (
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
        }
        empty={
          <p className="px-2 py-1 font-sans text-sm/sm text-text-muted">
            Nothing after this song. Use “Play next” or “Add to queue” on any song.
          </p>
        }
      />
    </aside>
  );
}
