import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@media/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { Fragment, useCallback, useId, useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";

/** One choice in a column, such as an audio track or a version of the film. */
export type TrackOption = {
  readonly id: string;
  readonly label: string;
  /** A muted line under the label, such as a version's `4K · HDR10 · HEVC`. */
  readonly detail?: string | undefined;
};

type OptionSpan = { readonly top: number; readonly bottom: number };

function checkedSpan(list: HTMLElement): OptionSpan | null {
  const checked = list.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');

  if (checked === null) return null;

  // Offsets, unlike client rects, ignore the popup's opening scale.
  const { scrollPaddingTop, scrollPaddingBottom } = getComputedStyle(list);
  const above = Number.parseFloat(scrollPaddingTop) || 0;
  const below = Number.parseFloat(scrollPaddingBottom) || 0;

  return {
    top: checked.offsetTop - above,
    bottom: checked.offsetTop + checked.offsetHeight + below,
  };
}

function shows(list: HTMLElement, span: OptionSpan, height: number): boolean {
  return span.top >= list.scrollTop && span.bottom <= list.scrollTop + height;
}

function reveal(list: HTMLElement, span: OptionSpan): void {
  if (span.top < list.scrollTop) list.scrollTop = span.top;
  else if (span.bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = span.bottom - list.clientHeight;
  }
}

function revealChecked(list: HTMLElement): void {
  const span = checkedSpan(list);

  if (span !== null) reveal(list, span);
}

function keepCheckedInView(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;

  let height: number | undefined;

  const observer = new ResizeObserver(() => {
    const span = checkedSpan(list);

    if (span !== null && (height === undefined || shows(list, span, height))) reveal(list, span);

    height = list.clientHeight;
  });

  observer.observe(list);

  return () => observer.disconnect();
}

function TrackColumn({
  label,
  options,
  value,
  onValueChange,
  footer,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<TrackOption>;
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  readonly footer: ReactElement | undefined;
}) {
  const labelId = useId();

  const list = useRef<HTMLElement | null>(null);

  const attachList = useCallback((element: HTMLElement | null) => {
    list.current = element;

    const release = keepCheckedInView(element);

    return () => {
      release?.();
      list.current = null;
    };
  }, []);

  const optionIds = options.map((option) => option.id).join("\n");

  useLayoutEffect(() => {
    if (list.current !== null) revealChecked(list.current);
  }, [value, optionIds]);

  return (
    <div className="flex min-w-50 flex-1 flex-col gap-0.5 pt-5">
      <span
        id={labelId}
        className="shrink-0 px-5 pb-1.5 font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase"
      >
        {label}
      </span>
      <RadioGroup
        ref={attachList}
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onValueChange(next)}
        className={cn(
          "relative flex min-h-0 scroll-py-1 flex-col gap-0.5 overflow-y-auto overscroll-y-contain px-5 pt-1",
          footer === undefined ? "pb-5" : "pb-3",
        )}
      >
        {options.map((option) => (
          <Radio.Root
            key={option.id}
            value={option.id}
            className="group/track flex min-h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-bar py-1.5 text-left font-sans text-body/label text-text-muted transition-colors hover:text-text data-checked:font-semibold data-checked:text-text"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center",
                option.detail !== undefined && "self-start pt-0.5",
              )}
            >
              <Radio.Indicator>
                <CheckIcon className="size-4 text-accent" strokeWidth={2.5} aria-hidden />
              </Radio.Indicator>
            </span>
            {option.detail === undefined ? (
              <span className="min-w-0 wrap-break-word">{option.label}</span>
            ) : (
              <span className="flex min-w-0 flex-col gap-0.5 wrap-break-word">
                {option.label}
                <span className="text-caption/caption font-regular text-text-muted">
                  {option.detail}
                </span>
              </span>
            )}
          </Radio.Root>
        ))}
      </RadioGroup>
      {footer}
    </div>
  );
}

/** One column of choices, such as the audio tracks, the subtitles, or the stream quality. */
export type TrackChoice = {
  /** Stable key, such as `audio`. */
  readonly id: string;
  readonly label: string;
  readonly options: ReadonlyArray<TrackOption>;
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** What sits under the options, outside their scrolling, such as the subtitle delay. */
  readonly footer?: ReactElement | undefined;
};

/** The columns of choices, left to right. */
export type TrackSelection = {
  readonly choices: ReadonlyArray<TrackChoice>;
};

const PANEL_WIDTHS = ["w-60", "w-60", "w-115", "w-170", "w-225"] as const;

/**
 * The player's chooser: one column per choice (the version when a title has several, audio,
 * subtitles, and quality in the player).
 * Each column is a radio group: arrow keys move the choice, Tab moves between columns. Given a
 * `max-h-*`, each column's options scroll under its heading; given a `max-w-*`, the columns scroll
 * sideways.
 */
export function TrackPanel({
  className,
  choices,
}: TrackSelection & { readonly className?: string }) {
  return (
    <div
      data-slot="track-panel"
      className={cn(
        "flex overflow-hidden rounded-control border border-hairline bg-surface-raised",
        PANEL_WIDTHS[Math.min(choices.length, PANEL_WIDTHS.length - 1)],
        className,
      )}
    >
      {choices.map((choice, index) => (
        <Fragment key={choice.id}>
          {index > 0 ? <div aria-hidden className="w-px shrink-0 bg-hairline" /> : null}
          <TrackColumn
            label={choice.label}
            options={choice.options}
            value={choice.value}
            onValueChange={choice.onValueChange}
            footer={choice.footer}
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The {@link TrackPanel} in a popover above the player's tracks button. Focus moves into the panel
 * when it opens and returns to the button when it closes; Escape closes it.
 *
 * @param trigger - The button that opens it, such as a `PlayerButton` with the captions glyph.
 * @param container - Where it renders; pass the full-screen element so it stays visible there.
 */
export function TrackPopover({
  trigger,
  container,
  label,
  choices,
}: TrackSelection & {
  /** The popover's accessible name, matching its trigger's, such as `Audio and subtitles`. */
  readonly label: string;
  readonly trigger: ReactElement;
  /** Where the popover renders, such as the player while it is full screen; the body otherwise. */
  readonly container?: HTMLElement | null | undefined;
}) {
  return (
    <Popover.Root>
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
            aria-label={label}
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <TrackPanel
              choices={choices}
              className="max-h-[min(var(--available-height),var(--spacing-track-panel))] max-w-(--available-width) overflow-x-auto overscroll-x-contain"
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
