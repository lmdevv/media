import { Slider } from "@base-ui/react/slider";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import {
  CaptionsIcon,
  GalleryVerticalEndIcon,
  LockIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UsersIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, FocusEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";

import { PauseGlyph, PlayGlyph, SkipNextGlyph } from "./icons";
import { SpriteThumbnail } from "./sprite-thumbnail";
import type { SpriteTile } from "./sprite-thumbnail";

function FullscreenGlyph(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
      {...props}
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

/**
 * A bare transport button: a white glyph with a label for assistive tech. `active` draws the
 * translucent square Paper puts behind an open panel's button. The glyph takes no pointer events:
 * a glyph swapped under the pointer, as mute swaps it, would take the pointer's `pointerout` with
 * it, and React would miss the pointer leaving.
 */
export function PlayerButton({
  className,
  type = "button",
  active = false,
  ...props
}: ComponentProps<"button"> & { readonly "aria-label": string; readonly active?: boolean }) {
  return (
    <button
      type={type}
      data-active={active || undefined}
      className={cn(
        "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-bar text-text transition-opacity before:absolute before:-inset-2 before:rounded-control before:bg-text/14 before:opacity-0 hover:opacity-80 disabled:opacity-(--opacity-disabled) data-active:before:opacity-100 data-popup-open:before:opacity-100 [&_svg]:pointer-events-none [&_svg]:relative [&_svg]:size-6.5",
        className,
      )}
      {...props}
    />
  );
}

const KEY_PREVIEW_MS = 1_200;

const SEEK_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/** What the scrubber shows above a time: its thumbnail and chapter, when known. */
export interface ScrubPreview {
  readonly thumbnail: SpriteTile | null;
  readonly chapter: string | null;
}

const NO_PREVIEW: ScrubPreview = { thumbnail: null, chapter: null };

/**
 * The playback scrubber. Arrow keys step 5 seconds and Page Up/Down a minute; the value text reads
 * the position as a timecode. Hovering or dragging shows the time under the pointer with its
 * thumbnail and chapter (`describe`); `chapters` draws a tick at each chapter's start.
 *
 * @param preview - Shows the preview at this time without a pointer, as after a keyboard seek.
 * @param onPreviewStart - Called once the viewer first points at or focuses the scrubber, so
 *   thumbnails can load before they are needed.
 */
export function Scrubber({
  position,
  duration,
  onSeek,
  onSeekCommit,
  describe,
  chapters,
  preview,
  onPreviewStart,
  className,
}: {
  readonly position: number;
  readonly duration: number;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: ((seconds: number) => void) | undefined;
  readonly describe?: ((seconds: number) => ScrubPreview) | undefined;
  /** Chapter starts in seconds. */
  readonly chapters?: ReadonlyArray<number> | undefined;
  readonly preview?: number | null | undefined;
  readonly onPreviewStart?: (() => void) | undefined;
  readonly className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [keyed, setKeyed] = useState(false);
  const keyedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const length = Math.max(duration, 1);

  useEffect(() => () => clearTimeout(keyedTimer.current), []);

  const showKeyed = (): void => {
    setKeyed(true);
    clearTimeout(keyedTimer.current);
    keyedTimer.current = setTimeout(() => setKeyed(false), KEY_PREVIEW_MS);
  };

  useEffect(() => {
    if (!dragging) return undefined;

    const end = (): void => setDragging(false);

    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);

    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  const track = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));

    setHover(fraction * duration);
  };

  const shown = dragging || keyed ? Math.min(position, duration) : (hover ?? preview ?? null);
  const details = shown === null ? NO_PREVIEW : (describe?.(shown) ?? NO_PREVIEW);

  return (
    <Slider.Root
      value={Math.min(position, duration)}
      min={0}
      max={length}
      step={5}
      largeStep={60}
      onValueChange={(value) => onSeek(value)}
      onValueCommitted={(value) => {
        setDragging(false);
        onSeekCommit?.(value);
      }}
      className={cn("flex-1", className)}
    >
      <Slider.Control
        data-slot="scrubber"
        onPointerEnter={onPreviewStart}
        onPointerDown={(event) => {
          if (event.button === 0) setDragging(true);
        }}
        onPointerMove={track}
        onPointerLeave={() => setHover(null)}
        onFocus={onPreviewStart}
        className="relative flex h-3.5 w-full cursor-pointer touch-none items-center"
      >
        {shown === null ? null : (
          <span
            aria-hidden
            data-slot="scrubber-hover"
            className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 flex-col items-center gap-1.5"
            style={{ left: `${String((shown / length) * 100)}%` }}
          >
            {details.thumbnail === null ? null : (
              <SpriteThumbnail
                tile={details.thumbnail}
                className="w-48 shadow-overlay ring-1 ring-text/25"
              />
            )}
            {details.chapter === null ? null : (
              <span
                data-slot="scrubber-chapter"
                className="max-w-48 truncate font-sans text-label/caption font-semibold text-text"
              >
                {details.chapter}
              </span>
            )}
            <span data-slot="scrubber-time" className="font-mono text-label/caption text-text">
              {formatTimecode(shown)}
            </span>
            <span className="h-3 w-0.5 rounded-bar bg-text" />
          </span>
        )}
        <Slider.Track className="relative h-1 w-full rounded-bar bg-text/25">
          <Slider.Indicator className="rounded-bar bg-accent" />
          {(chapters ?? [])
            .filter((start) => start > 0 && start < duration)
            .map((start) => (
              <span
                key={start}
                aria-hidden
                data-slot="scrubber-chapter-mark"
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-dark-bg/70"
                style={{ left: `${String((start / length) * 100)}%` }}
              />
            ))}
          <Slider.Thumb
            aria-label="Seek"
            onKeyDown={(event) => {
              if (SEEK_KEYS.has(event.key)) showKeyed();
            }}
            getAriaValueText={(_, value) =>
              `${formatTimecode(value)} of ${formatTimecode(duration)}`
            }
            className="size-3.5 rounded-pill bg-accent"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

function ProgressLine({
  position,
  duration,
}: {
  readonly position: number;
  readonly duration: number;
}) {
  const fraction = duration <= 0 ? 0 : Math.min(1, Math.max(0, position / duration));

  return (
    <div
      role="progressbar"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={`${formatTimecode(position)} of ${formatTimecode(duration)}`}
      className="flex h-1 flex-1 rounded-bar bg-text/25"
    >
      <div className="h-1 rounded-bar bg-accent" style={{ width: `${String(fraction * 100)}%` }} />
    </div>
  );
}

const HOVER_CLOSE_MS = 250;

const IDLE_MS = 3_000;

type Reason = "hover" | "focus" | "drag" | "touch";

const percent = (level: number): number => Math.round(Math.min(1, Math.max(0, level)) * 100);

function VolumeControl({
  volume,
  muted,
  onMuteChange,
  onVolumeChange,
  onVolumeCommit,
  onOpenChange,
}: {
  readonly volume: number | null;
  readonly muted: boolean;
  readonly onMuteChange: (muted: boolean) => void;
  readonly onVolumeChange?: ((volume: number) => void) | undefined;
  readonly onVolumeCommit?: ((volume: number) => void) | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const reasons = useRef(new Set<Reason>());
  const openNow = useRef(false);
  const group = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressedWith = useRef<string | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const dismissed = useRef(false);
  const latest = useRef({ onVolumeCommit, onOpenChange });

  useLayoutEffect(() => {
    latest.current = { onVolumeCommit, onOpenChange };
  });
  const [moving, setMoving] = useState<number | null>(null);
  const movingNow = useRef<number | null>(null);

  const move = (value: number | null): void => {
    movingNow.current = value;
    setMoving(value);
  };

  const settle = (): void => {
    const value = movingNow.current;

    if (value === null) return;
    move(null);
    latest.current.onVolumeCommit?.(value / 100);
  };

  const silent = muted || volume === 0;
  const settable = volume !== null && onVolumeChange !== undefined;

  const hold = (reason: Reason, on: boolean): void => {
    if (on) reasons.current.add(reason);
    else reasons.current.delete(reason);

    const next = reasons.current.size > 0;

    if (next === openNow.current) return;
    openNow.current = next;
    setOpen(next);

    if (!next) settle();
    latest.current.onOpenChange?.(next);
  };

  const pressing = useRef(false);

  const release = useEffectEvent((reason: Reason) => hold(reason, false));
  const settleCut = useEffectEvent(() => settle());

  const unmount = useEffectEvent(() => {
    clearTimeout(hoverTimer.current);
    clearTimeout(idleTimer.current);
    reasons.current.clear();

    if (!openNow.current) return;
    openNow.current = false;
    setOpen(false);
    onOpenChange?.(false);
  });

  useEffect(() => {
    const dropped = (): void => {
      pressing.current = false;
      release("drag");
    };

    const cancelled = (): void => {
      dropped();
      settleCut();
    };

    const outside = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && group.current?.contains(event.target) === true) return;
      release("touch");
    };

    window.addEventListener("pointerup", dropped);
    window.addEventListener("pointercancel", cancelled);
    // A release the window never hears, as when it loses focus mid-drag, ends the drag too.
    window.addEventListener("blur", cancelled);
    window.addEventListener("pointerdown", outside);

    return () => {
      window.removeEventListener("pointerup", dropped);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("blur", cancelled);
      window.removeEventListener("pointerdown", outside);
      unmount();
    };
  }, []);

  const enter = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    dismissed.current = false;
    clearTimeout(hoverTimer.current);
    hold("hover", true);
  };

  const leave = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;

    const pressed = event.buttons !== 0;

    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const active = document.activeElement;

      const keyboardFocus =
        active instanceof HTMLElement &&
        group.current?.contains(active) === true &&
        active.matches(":focus-visible");

      if (!pressed) hold("drag", false);

      if (!keyboardFocus) hold("focus", false);
      hold("hover", false);
    }, HOVER_CLOSE_MS);
  };

  const focus = (event: FocusEvent): void => {
    if (dismissed.current) return;
    hold(
      "focus",
      !pressing.current &&
        event.target instanceof HTMLElement &&
        event.target.matches(":focus-visible"),
    );
    idleAgain();
  };

  const blur = (event: FocusEvent): void => {
    if (
      event.relatedTarget instanceof Node &&
      group.current?.contains(event.relatedTarget) === true
    )
      return;
    dismissed.current = false;
    hold("focus", false);
  };

  const idleAgain = (): void => {
    if (!reasons.current.has("touch") && !reasons.current.has("focus")) return;
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (reasons.current.has("focus")) dismissed.current = true;

      const active = document.activeElement;

      if (
        active !== button.current &&
        active !== null &&
        group.current?.contains(active) === true
      ) {
        button.current?.focus();
      }

      hold("touch", false);
      hold("focus", false);
    }, IDLE_MS);
  };

  const toggleMute = (): void => {
    const touch = pressedWith.current === "touch";

    pressedWith.current = null;

    if (touch && settable && !reasons.current.has("touch")) {
      hold("touch", true);
      idleAgain();

      return;
    }

    onMuteChange(!silent);
  };

  const dismiss = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !openNow.current || !settable) return;
    event.preventDefault();
    event.stopPropagation();
    dismissed.current = true;

    for (const reason of reasons.current) hold(reason, false);
    button.current?.focus();
  };

  const level = muted || volume === null ? 0 : percent(volume);
  const shown = moving ?? level;

  return (
    <div
      ref={group}
      className="relative flex"
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDownCapture={(event) => {
        pressing.current = true;

        if (event.pointerType === "touch" && openNow.current) hold("touch", true);
        hold("focus", false);
        idleAgain();
      }}
      onFocus={focus}
      onBlur={blur}
      onKeyDown={(event) => {
        dismiss(event);
        idleAgain();
      }}
    >
      <PlayerButton
        ref={button}
        aria-label={silent ? "Unmute" : "Mute"}
        aria-pressed={silent}
        onPointerDown={(event) => {
          pressedWith.current = event.pointerType;
        }}
        onKeyDown={() => {
          pressedWith.current = null;
        }}
        onClick={toggleMute}
      >
        {silent ? (
          <VolumeXIcon strokeWidth={1.75} aria-hidden />
        ) : volume !== null && volume < 0.5 ? (
          <Volume1Icon strokeWidth={1.75} aria-hidden />
        ) : (
          <Volume2Icon strokeWidth={1.75} aria-hidden />
        )}
      </PlayerButton>
      {open && settable ? (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 pb-4">
          <Slider.Root
            orientation="vertical"
            min={0}
            max={100}
            step={1}
            largeStep={10}
            value={shown}
            onValueChange={(next) => {
              idleAgain();
              move(next);
              onVolumeChange(next / 100);
            }}
            onValueCommitted={(next) => {
              move(null);
              onVolumeCommit?.(next / 100);
            }}
            className="flex h-35 w-11 justify-center rounded-control border border-hairline bg-surface-raised py-4 shadow-overlay"
          >
            <Slider.Control
              data-slot="volume-slider"
              onPointerDown={(event) => {
                if (event.button === 0) hold("drag", true);
              }}
              className="flex h-full w-full cursor-pointer touch-none justify-center"
            >
              <Slider.Track className="relative h-full w-1 rounded-bar bg-text/25">
                <Slider.Indicator className="w-1 rounded-bar bg-accent" />
                <Slider.Thumb
                  aria-label="Volume"
                  getAriaValueText={(_, value) =>
                    muted && moving === null ? "Muted" : `${String(value)}%`
                  }
                  className="size-3.5 rounded-pill bg-accent outline-none focus-visible:ring-2 focus-visible:ring-text"
                />
              </Slider.Track>
            </Slider.Control>
          </Slider.Root>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The player's bottom controls over a dark gradient: scrubber and remaining time, transport on the
 * left, the title in the middle, and next episode, tracks, room and fullscreen on the right.
 *
 * @param position - Seconds played.
 * @param onSeek - Follows the scrubber while it moves; `onSeekCommit` gets where it was let go,
 *   and the skip buttons' targets.
 * @param duration - Length in seconds.
 * @param tracks - The audio and subtitles control, usually a {@link TrackPopover} trigger.
 * @param chapterList - The chapters control, usually a `ChapterPopover` trigger.
 * @param scrub - Thumbnails, chapter marks, and a forced preview for the scrubber
 *   ({@link Scrubber}).
 * @param locked - Replaces the transport and the scrubber with a lock line, such as `Only Alex
 *   can pause or seek`, for a room guest.
 * @param roomActive - The room panel is open, so its button shows as active.
 * @param volume - The level for the slider beside mute, or null where the page cannot set it
 *   ({@link VolumeControl}).
 * @param episodes - The Episodes control, usually an `EpisodePopover` trigger; shows beside next
 *   episode.
 */
export function PlayerControls({
  title,
  playing,
  position,
  duration,
  muted = false,
  volume = null,
  tracks,
  chapterList,
  episodes,
  scrub,
  locked,
  roomActive = false,
  onPlayPause,
  onSeek,
  onSeekCommit,
  onMuteChange,
  onVolumeChange,
  onVolumeCommit,
  onVolumeOpenChange,
  onNext,
  onRoom,
  onFullscreen,
  className,
}: {
  readonly title: string;
  readonly playing: boolean;
  readonly position: number;
  readonly duration: number;
  readonly muted?: boolean;
  readonly volume?: number | null;
  readonly tracks?: ReactNode;
  readonly chapterList?: ReactNode;
  readonly episodes?: ReactNode;
  readonly scrub?: Pick<
    ComponentProps<typeof Scrubber>,
    "describe" | "chapters" | "preview" | "onPreviewStart"
  >;
  readonly locked?: string | undefined;
  readonly roomActive?: boolean;
  readonly onPlayPause: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit?: ((seconds: number) => void) | undefined;
  readonly onMuteChange?: ((muted: boolean) => void) | undefined;
  readonly onVolumeChange?: ((volume: number) => void) | undefined;
  readonly onVolumeCommit?: ((volume: number) => void) | undefined;
  /** Whether something holds the volume slider open, so the controls can stay up meanwhile. */
  readonly onVolumeOpenChange?: ((open: boolean) => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onRoom?: (() => void) | undefined;
  readonly onFullscreen?: (() => void) | undefined;
  readonly className?: string;
}) {
  const skip = (by: number): void =>
    (onSeekCommit ?? onSeek)(Math.min(duration, Math.max(0, position + by)));

  return (
    <div
      data-slot="player-controls"
      className={cn(
        "on-media flex w-full flex-col gap-5 bg-linear-to-b from-transparent to-dark-bg/85 to-60% px-10 pt-30 pb-9",
        className,
      )}
    >
      <div className="flex items-center gap-3.5">
        {locked === undefined ? (
          <Scrubber
            position={position}
            duration={duration}
            onSeek={onSeek}
            onSeekCommit={onSeekCommit}
            {...scrub}
          />
        ) : (
          <ProgressLine position={position} duration={duration} />
        )}
        <span className="font-mono text-label/caption text-text tabular-nums">
          {formatTimecode(position - duration)}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <div className="flex items-center gap-6.5">
          {locked === undefined ? (
            <>
              <PlayerButton
                aria-label={playing ? "Pause" : "Play"}
                onClick={onPlayPause}
                className="[&_svg]:size-7"
              >
                {playing ? <PauseGlyph /> : <PlayGlyph />}
              </PlayerButton>
              <PlayerButton aria-label="Back 10 seconds" onClick={() => skip(-10)}>
                <RotateCcwIcon strokeWidth={1.75} aria-hidden />
              </PlayerButton>
              <PlayerButton aria-label="Forward 10 seconds" onClick={() => skip(10)}>
                <RotateCwIcon strokeWidth={1.75} aria-hidden />
              </PlayerButton>
            </>
          ) : (
            <span className="flex h-9 items-center gap-2.5 rounded-pill bg-text/10 pr-3.5 pl-3 font-sans text-label/caption font-medium text-text">
              <LockIcon className="size-4" strokeWidth={1.75} aria-hidden />
              {locked}
            </span>
          )}
          {onMuteChange === undefined ? null : (
            <VolumeControl
              volume={volume}
              muted={muted}
              onMuteChange={onMuteChange}
              onVolumeChange={onVolumeChange}
              onVolumeCommit={onVolumeCommit}
              onOpenChange={onVolumeOpenChange}
            />
          )}
        </div>
        <p className="truncate text-center font-sans text-lead/body font-semibold">{title}</p>
        <div className="flex items-center justify-end gap-6">
          {onNext === undefined ? null : (
            <PlayerButton aria-label="Next episode" onClick={onNext}>
              <SkipNextGlyph />
            </PlayerButton>
          )}
          {episodes}
          {chapterList}
          {tracks}
          {onRoom === undefined ? null : (
            <PlayerButton
              aria-label="Watch together"
              aria-pressed={roomActive}
              active={roomActive}
              onClick={onRoom}
            >
              <UsersIcon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          )}
          {onFullscreen === undefined ? null : (
            <PlayerButton aria-label="Full screen" onClick={onFullscreen}>
              <FullscreenGlyph />
            </PlayerButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** The stacked-cards glyph of the Episodes button. */
export function EpisodesGlyph() {
  return <GalleryVerticalEndIcon strokeWidth={1.75} aria-hidden />;
}

/** The captions glyph used by the audio and subtitles button. */
export function TracksGlyph() {
  return <CaptionsIcon strokeWidth={1.75} aria-hidden />;
}
