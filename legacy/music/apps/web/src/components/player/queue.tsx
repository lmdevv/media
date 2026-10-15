import type { QueueItemId } from "@music/commands/ids";
import type { QueueEntry } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRead, useRun } from "@music/sdk/react";
import { Switch } from "@music/ui/components/switch";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { MoveButtons, ReorderHandle, useReorder } from "@/components/library/reorder";
import type { Reorder } from "@/components/library/reorder";
import { useUi } from "@/components/shell/ui-state";
import { toastFailure, useAction } from "@/lib/action";
import { formatDuration } from "@/lib/format";
import { dropLine } from "@/lib/reorder";

import { perform } from "./controls";
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
export const useClearQueue = () => {
  const clear = useRun("queue.clear");

  return useAction(() => clear({}), { success: () => "Cleared the queue" });
};

type Tone = "plain" | "glass";

/** Reordering for one row: its place in the list and how to move it. */
interface RowReorder {
  readonly index: number;
  readonly count: number;
  readonly reorder: Reorder;
  /** Phones show up/down buttons in reorder mode instead of the drag handle. */
  readonly mode: "drag" | "buttons";
}

/**
 * One queued song. Click to play it; the remove button appears on hover or focus. `tone="glass"`
 * draws it for the art-tinted Now Playing background. `addedBy` names who queued it when that is
 * someone else.
 */
function QueueRow({
  entry,
  tone = "plain",
  current = false,
  showAddedBy = false,
  reorder,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly tone?: Tone;
  readonly current?: boolean;
  readonly showAddedBy?: boolean;
  readonly reorder?: RowReorder;
  /** Removes the entry from the queue; a row without it has no remove button. */
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
      <QueueRowText entry={entry} glass={glass} current={current} showAddedBy={showAddedBy} />
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

/** A queue row's title, and its artist with who added it when that is worth saying. */
function QueueRowText({
  entry,
  glass,
  current,
  showAddedBy,
}: {
  readonly entry: QueueEntry;
  readonly glass: boolean;
  readonly current: boolean;
  readonly showAddedBy: boolean;
}) {
  const byline =
    showAddedBy && entry.addedBy !== null
      ? `${entry.artist} · Added by ${entry.addedBy.name}`
      : entry.artist;

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
        {byline}
      </span>
    </div>
  );
}

/**
 * The end of a queue row: playing bars on the current song, up/down buttons in reorder mode, and
 * otherwise the length (Now Playing) and the remove button.
 */
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

/** Whether entries should say who added them: only when someone other than you added any. */
const useShowAddedBy = (entries: ReadonlyArray<QueueEntry>): boolean => {
  const me = useRead("account.me", {});

  return entries.some((entry) => entry.addedBy !== null && entry.addedBy.id !== me?.id);
};

/**
 * Removing queue entries one at a time, moving focus to the row that takes a removed one's place,
 * or to the new last row, instead of dropping it to the page (ADS-107); with no rows left, the
 * list itself takes focus. Returns the list's ref and the remove handler for a row.
 */
const useQueueRemoval = (entries: ReadonlyArray<QueueEntry>) => {
  const player = usePlayer();
  const list = useRef<HTMLDivElement>(null);
  // Set once a removal has landed (a failure shows as the player error and sets nothing). The
  // queue can reach this view a render later, so focus moves when the list no longer shows it.
  const [removed, setRemoved] = useState<LandedRemoval | null>(null);
  const handled = useRef<LandedRemoval | null>(null);
  const signature = entries.map((entry) => entry.itemId).join(" ");

  useEffect(() => {
    const element = list.current;

    if (removed === null || handled.current === removed || element === null) return;

    const active = document.activeElement;
    // Inside Now Playing the dialog itself takes focus when the removed row's button unmounts, so
    // focus on that popup is free too; focus on any other control in it is the user's choice.
    const popup = element.closest("[role=dialog]");

    // Entry IDs are unique, so "the song's count dropped" means this entry is gone.
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

  // One removal at a time: a second click before the first lands would act on a stale list.
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
  const move = useRun("queue.move");
  const { current, queued, autoplay } = useUpNext();
  const showAddedBy = useShowAddedBy(queued);
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
                  showAddedBy={showAddedBy}
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

/** "Autoplay · similar in your library", with its toggle. Off hides the songs it would add. */
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
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate font-mono text-xs/xs tracking-mono uppercase",
              glass ? "text-text/55" : "text-text-muted",
            )}
          >
            Autoplay · similar in your library
          </span>
          {player.autoplay ? (
            <span
              className={cn("font-sans text-xs/xs", glass ? "text-text/45" : "text-text-muted")}
            >
              Same artist, then genre, then era
            </span>
          ) : null}
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
