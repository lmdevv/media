import { Popover } from "@base-ui/react/popover";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import { useState } from "react";
import type { ReactElement } from "react";

import { SpriteThumbnail } from "./sprite-thumbnail";
import type { SpriteTile } from "./sprite-thumbnail";

/** One chapter in the list. */
export interface ChapterOption {
  readonly id: string;
  readonly title: string;
  /** Where the chapter starts, in seconds. */
  readonly startSeconds: number;
  /** A frame from the chapter's start, when the file has scrub thumbnails. */
  readonly thumbnail: SpriteTile | null;
}

/**
 * The chapter list: each chapter's frame (when there are thumbnails), title, and start time. The
 * chapter playing is marked; choosing one plays from its start.
 */
export function ChapterList({
  chapters,
  currentId,
  onSelect,
  className,
}: {
  readonly chapters: ReadonlyArray<ChapterOption>;
  readonly currentId: string | null;
  readonly onSelect: (chapter: ChapterOption) => void;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="chapter-list"
      className={cn(
        "flex max-h-[min(var(--spacing-chapter-list),70vh)] w-90 flex-col gap-0.5 overflow-y-auto rounded-control border border-hairline bg-surface-raised p-3",
        className,
      )}
    >
      <span className="px-2 pt-2 pb-2.5 font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase">
        Chapters
      </span>
      {chapters.map((chapter) => {
        const current = chapter.id === currentId;

        return (
          <button
            key={chapter.id}
            type="button"
            aria-current={current || undefined}
            onClick={() => onSelect(chapter)}
            className="flex cursor-pointer items-center gap-3 rounded-bar p-2 text-left font-sans text-body/label text-text-muted transition-colors hover:bg-text/8 hover:text-text aria-current:font-semibold aria-current:text-text"
          >
            {chapter.thumbnail === null ? null : (
              <SpriteThumbnail tile={chapter.thumbnail} className="w-24 shrink-0" />
            )}
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <span className="truncate">{chapter.title}</span>
              <span className="font-mono text-caption/caption text-text-muted">
                {formatTimecode(chapter.startSeconds)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The {@link ChapterList} in a popover above the player's chapters button. Choosing a chapter
 * closes it.
 *
 * @param trigger - The button that opens it.
 * @param container - Where it renders; pass the full-screen element so it stays visible there.
 */
export function ChapterPopover({
  trigger,
  container,
  chapters,
  currentId,
  onSelect,
}: {
  readonly trigger: ReactElement;
  readonly container?: HTMLElement | null | undefined;
  readonly chapters: ReadonlyArray<ChapterOption>;
  readonly currentId: string | null;
  readonly onSelect: (chapter: ChapterOption) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal container={container}>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={76}
          alignOffset={-32}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            aria-label="Chapters"
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <ChapterList
              chapters={chapters}
              currentId={currentId}
              onSelect={(chapter) => {
                setOpen(false);
                onSelect(chapter);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
