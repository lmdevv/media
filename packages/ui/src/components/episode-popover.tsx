import { Popover } from "@base-ui/react/popover";
import { cn } from "@media/ui/lib/utils";
import { useCallback, useRef } from "react";
import type { KeyboardEvent, ReactElement, Ref } from "react";

import { Chip } from "./chip";
import { ProgressBar } from "./progress-bar";

/** One season to browse, such as `Season 2`. */
export interface SeasonOption {
  readonly seasonNumber: number;
  readonly name: string;
}

/** One episode in the list, by the caller's own id type. */
export interface EpisodeOption<Id extends string = string> {
  readonly id: Id;
  readonly episodeNumber: number;
  readonly title: string;
  /** A muted line under the title, such as `24m · 12m left` or `File missing`. */
  readonly detail?: string | undefined;
  /** The episode's still, when it has one. */
  readonly image?: string | undefined;
  /** How much of it the profile has watched, from 0 to 1, when started. */
  readonly progress?: number | undefined;
  /** False when no file of it is on disk, so it cannot play. */
  readonly available: boolean;
}

interface EpisodeBrowser<Id extends string> {
  /** Every season of the show; the chips to switch between them show only when there are several. */
  readonly seasons: ReadonlyArray<SeasonOption>;
  /** The season the list shows. */
  readonly seasonNumber: number;
  readonly onSeasonChange: (seasonNumber: number) => void;
  /** The season's episodes in order, or null while they load. */
  readonly episodes: ReadonlyArray<EpisodeOption<Id>> | null;
  /** The episode playing, marked in the list. */
  readonly currentId: Id;
  readonly onSelect: (episode: EpisodeOption<Id>) => void;
}

const LOADING_ROWS = [0, 1, 2] as const;

const focusTarget = (
  items: ReadonlyArray<HTMLElement>,
  at: number,
  key: string,
  chips: boolean,
): HTMLElement | undefined => {
  const step = (by: 1 | -1): HTMLElement | undefined =>
    items[at === -1 ? 0 : Math.min(items.length - 1, Math.max(0, at + by))];

  switch (key) {
    case "ArrowDown":
      return chips ? undefined : step(1);
    case "ArrowUp":
      return chips ? undefined : step(-1);
    case "Home":
      return chips ? undefined : items[0];
    case "End":
      return chips ? undefined : items.at(-1);
    case "ArrowRight":
      return chips ? step(1) : undefined;
    case "ArrowLeft":
      return chips ? step(-1) : undefined;
    default:
      return undefined;
  }
};

const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) return;

  if (event.key === " " || event.key.startsWith("Arrow")) event.stopPropagation();

  const chips = target.closest('[data-slot="season-chips"]');
  const scope = chips ?? event.currentTarget;
  const selector = chips === null ? '[data-slot="episode-row"]:enabled' : "button";
  const items = [...scope.querySelectorAll<HTMLElement>(selector)];
  const next = focusTarget(items, items.indexOf(target), event.key, chips !== null);

  if (next === undefined) return;

  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
};

function EpisodeList<Id extends string>({
  seasons,
  seasonNumber,
  onSeasonChange,
  episodes,
  currentId,
  onSelect,
  currentRef,
  listRef,
  className,
}: EpisodeBrowser<Id> & {
  readonly currentRef?: Ref<HTMLButtonElement> | undefined;
  readonly listRef?: Ref<HTMLDivElement> | undefined;
  readonly className?: string;
}) {
  const season = seasons.find((candidate) => candidate.seasonNumber === seasonNumber);

  return (
    <div
      ref={listRef}
      data-slot="episode-list"
      tabIndex={-1}
      onKeyDown={onListKeyDown}
      className={cn(
        "flex w-100 flex-col overflow-hidden rounded-control outline-none border border-hairline bg-surface-raised",
        className,
      )}
    >
      <div className="flex shrink-0 flex-col gap-3 px-5 pt-5 pb-2">
        <span className="font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase">
          Episodes
        </span>
        {seasons.length > 1 ? (
          <div
            data-slot="season-chips"
            role="group"
            aria-label="Season"
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
          >
            {seasons.map((candidate) => {
              const selected = candidate.seasonNumber === seasonNumber;

              return (
                <Chip
                  key={candidate.seasonNumber}
                  selected={selected}
                  onClick={() => onSeasonChange(candidate.seasonNumber)}
                  className={selected ? undefined : "bg-text/8"}
                >
                  {candidate.name}
                </Chip>
              );
            })}
          </div>
        ) : (
          <span className="font-sans text-body/label font-semibold text-text">
            {season?.name ?? `Season ${String(seasonNumber)}`}
          </span>
        )}
      </div>
      <ol className="flex min-h-0 scroll-py-1 flex-col gap-0.5 overflow-y-auto overscroll-y-contain px-3 pt-1 pb-3">
        {episodes === null
          ? LOADING_ROWS.map((row) => (
              <li key={row} aria-hidden className="flex items-center gap-3 p-2">
                <span className="w-6" />
                <span className="aspect-video w-24 shrink-0 rounded-poster bg-text/5" />
                <span className="h-4 w-40 rounded-bar bg-text/6" />
              </li>
            ))
          : episodes.map((episode) => {
              const current = episode.id === currentId;

              return (
                <li key={episode.id}>
                  <button
                    ref={current ? currentRef : undefined}
                    type="button"
                    data-slot="episode-row"
                    aria-current={current || undefined}
                    disabled={!episode.available && !current}
                    onClick={() => onSelect(episode)}
                    className="group/episode flex w-full cursor-pointer items-center gap-3 rounded-bar p-2 text-left font-sans text-body/label text-text-muted transition-colors outline-none hover:bg-text/8 hover:text-text focus-visible:bg-text/8 focus-visible:text-text disabled:cursor-default disabled:opacity-(--opacity-muted) disabled:hover:bg-transparent aria-current:bg-text/8 aria-current:text-text"
                  >
                    <span className="w-6 shrink-0 text-center font-mono text-label/label tabular-nums">
                      {episode.episodeNumber}
                    </span>
                    <span
                      className="relative flex aspect-video w-24 shrink-0 items-end overflow-hidden rounded-poster bg-text/5 bg-cover bg-center"
                      style={
                        episode.image === undefined
                          ? undefined
                          : { backgroundImage: `url("${episode.image}")` }
                      }
                    >
                      {episode.progress === undefined ? null : (
                        <ProgressBar value={episode.progress} thickness="thin" />
                      )}
                    </span>
                    <span className="flex min-w-0 grow flex-col gap-0.5">
                      <span className="truncate group-aria-current/episode:font-semibold">
                        {episode.title}
                      </span>
                      {current ? (
                        <span className="text-caption/caption font-semibold text-accent">
                          Playing
                        </span>
                      ) : episode.detail === undefined ? null : (
                        <span className="truncate text-caption/caption text-text-muted">
                          {episode.detail}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
      </ol>
    </div>
  );
}

/**
 * The {@link EpisodeList} in a popover above the player's Episodes button. It opens with focus on
 * the episode playing; Escape or a click outside closes it without changing playback, and focus
 * returns to the button.
 *
 * @param trigger - The button that opens it.
 * @param container - Where it renders; pass the player's overlay layer so it shows in full screen.
 */
export function EpisodePopover<Id extends string>({
  trigger,
  container,
  open,
  onOpenChange,
  onClosed,
  ...browser
}: EpisodeBrowser<Id> & {
  readonly trigger: ReactElement;
  readonly container?: HTMLElement | null | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The popover has finished closing, its exit animation included. */
  readonly onClosed?: (() => void) | undefined;
}) {
  const currentRow = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const currentRef = useCallback((row: HTMLButtonElement | null): void => {
    currentRow.current = row;

    if (row === null || document.activeElement !== list.current) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <Popover.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed?.();
      }}
    >
      <Popover.Trigger render={trigger} />
      <Popover.Portal container={container}>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={76}
          alignOffset={-32}
          collisionPadding={16}
          collisionAvoidance={{ side: "none", align: "shift" }}
          className="z-50"
        >
          <Popover.Popup
            aria-label="Episodes"
            initialFocus={() => {
              currentRow.current?.scrollIntoView({ block: "nearest" });

              return currentRow.current ?? list.current;
            }}
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <EpisodeList
              {...browser}
              currentRef={currentRef}
              listRef={list}
              className="max-h-[min(var(--available-height),var(--spacing-episode-panel))] max-w-(--available-width)"
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
