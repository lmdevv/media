import { usePlayer, usePlayerPosition } from "@music/player/react";
import { Slider } from "@music/ui/components/slider";
import { Spinner } from "@music/ui/components/spinner";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import {
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useState } from "react";

import { formatDuration } from "@/lib/format";

import { NEXT_REPEAT, perform } from "./player-actions";

const roundIcon =
  "flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-(--opacity-disabled)";

/** The filled circle play/pause button; shows a ring while the stream buffers. */
export function PlayPauseButton({
  className,
  iconClassName = "size-4",
  tone = "solid",
}: {
  readonly className?: string;
  readonly iconClassName?: string;
  readonly tone?: "solid" | "glass";
}) {
  const player = usePlayer();
  const playing = player.status === "playing";
  const waiting = player.status === "buffering" || player.status === "loading";

  if (waiting && player.track !== null) {
    return (
      <span className={cn(roundIcon, "size-10 text-text", className)}>
        <Spinner label="Buffering" className="size-full" />
      </span>
    );
  }

  return (
    <Tooltip label={playing ? "Pause" : "Play"} shortcut="Space">
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        disabled={player.track === null}
        onClick={() => perform(player.togglePlay())}
        className={cn(
          roundIcon,
          "size-10 hover:scale-105",
          tone === "solid" ? "bg-text text-text-inverse" : "bg-text/16 text-text hover:bg-text/24",
          className,
        )}
      >
        {playing ? (
          <PauseIcon className={iconClassName} fill="currentColor" strokeWidth={0} />
        ) : (
          <PlayIcon
            className={cn(iconClassName, "translate-x-px")}
            fill="currentColor"
            strokeWidth={0}
          />
        )}
      </button>
    </Tooltip>
  );
}

/** Previous and next buttons with filled glyphs. */
export function SkipButton({
  direction,
  className,
  iconClassName = "size-5",
}: {
  readonly direction: "previous" | "next";
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  const player = usePlayer();
  const Icon = direction === "previous" ? SkipBackIcon : SkipForwardIcon;
  const label = direction === "previous" ? "Previous" : "Next";

  return (
    <Tooltip label={label} shortcut={direction === "previous" ? "⇧←" : "⇧→"}>
      <button
        type="button"
        aria-label={label}
        disabled={player.track === null}
        onClick={() => perform(direction === "previous" ? player.previous() : player.next())}
        className={cn(roundIcon, "text-text hover:opacity-80", className)}
      >
        <Icon className={iconClassName} fill="currentColor" />
      </button>
    </Tooltip>
  );
}

/** Shuffle toggle; accent when on. */
export function ShuffleButton({
  className,
  iconClassName = "size-4.5",
}: {
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  const player = usePlayer();

  return (
    <Tooltip label={player.shuffle ? "Shuffle is on" : "Shuffle"}>
      <button
        type="button"
        aria-label="Shuffle"
        aria-pressed={player.shuffle}
        onClick={() => perform(player.setShuffle(!player.shuffle))}
        className={cn(
          roundIcon,
          player.shuffle ? "text-accent" : "text-text-muted hover:text-text",
          className,
        )}
      >
        <ShuffleIcon className={iconClassName} />
      </button>
    </Tooltip>
  );
}

const REPEAT_LABEL = { off: "Repeat", all: "Repeat all", one: "Repeat one" } as const;

/** Repeat cycles off → all → one; accent when on, with the 1 glyph for repeat one. */
export function RepeatButton({
  className,
  iconClassName = "size-4.5",
}: {
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  const player = usePlayer();
  const Icon = player.repeat === "one" ? Repeat1Icon : RepeatIcon;

  return (
    <Tooltip label={REPEAT_LABEL[player.repeat]}>
      <button
        type="button"
        aria-label={REPEAT_LABEL[player.repeat]}
        aria-pressed={player.repeat !== "off"}
        onClick={() => perform(player.setRepeat(NEXT_REPEAT[player.repeat]))}
        className={cn(
          roundIcon,
          player.repeat === "off" ? "text-text-muted hover:text-text" : "text-accent",
          className,
        )}
      >
        <Icon className={iconClassName} />
      </button>
    </Tooltip>
  );
}

/**
 * The seek bar with elapsed and total (or remaining) times. Dragging previews locally and seeks
 * when released.
 */
export function Progress({
  className,
  timeClassName = "w-9 font-mono text-xs/xs text-text-muted",
  layout = "inline",
  remaining = false,
  fillClassName,
  trackClassName,
  thumbClassName,
}: {
  readonly className?: string;
  readonly timeClassName?: string;
  readonly layout?: "inline" | "stacked";
  readonly remaining?: boolean;
  readonly fillClassName?: string;
  readonly trackClassName?: string;
  readonly thumbClassName?: string;
}) {
  const player = usePlayer();
  const position = usePlayerPosition();
  const [dragging, setDragging] = useState<number | null>(null);
  const duration = Math.max(player.durationMs, 1);
  const shown = Math.min(dragging ?? position, duration);

  const end = remaining
    ? `−${formatDuration(duration - shown)}`
    : formatDuration(player.durationMs);

  const slider = (
    <Slider
      aria-label="Seek"
      min={0}
      max={duration}
      step={1000}
      value={shown}
      disabled={player.track === null}
      onValueChange={(value) => setDragging(value)}
      onValueCommitted={(value) => {
        setDragging(null);
        perform(player.seek(value));
      }}
      fillClassName={fillClassName}
      trackClassName={trackClassName}
      thumbClassName={thumbClassName}
    />
  );

  if (layout === "stacked") {
    return (
      <div className={cn("flex flex-col gap-2.5", className)}>
        {slider}
        <div className="flex justify-between">
          <span className={timeClassName}>{formatDuration(shown)}</span>
          <span className={timeClassName}>{end}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex w-full items-center gap-2.5", className)}>
      <span className={cn(timeClassName, "shrink-0 text-right")}>{formatDuration(shown)}</span>
      {slider}
      <span className={cn(timeClassName, "shrink-0")}>{end}</span>
    </div>
  );
}

/** Volume icon and slider; the icon mutes and unmutes. */
export function Volume({
  className,
  sliderClassName = "w-22",
  fillClassName = "bg-text",
}: {
  readonly className?: string;
  readonly sliderClassName?: string;
  readonly fillClassName?: string;
}) {
  const player = usePlayer();
  const [dragging, setDragging] = useState<number | null>(null);
  const [restore, setRestore] = useState(1);
  const volume = dragging ?? player.volume;
  const Icon = volume === 0 ? VolumeXIcon : volume < 0.5 ? Volume1Icon : Volume2Icon;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Tooltip label={volume === 0 ? "Unmute" : "Mute"}>
        <button
          type="button"
          aria-label={volume === 0 ? "Unmute" : "Mute"}
          onClick={() => {
            if (volume > 0) setRestore(volume);
            perform(player.setVolume(volume === 0 ? restore : 0));
          }}
          className={cn(roundIcon, "text-text")}
        >
          <Icon className="size-5" />
        </button>
      </Tooltip>
      <Slider
        aria-label="Volume"
        className={sliderClassName}
        min={0}
        max={1}
        step={0.01}
        value={volume}
        fillClassName={fillClassName}
        onValueChange={(value) => setDragging(value)}
        onValueCommitted={(value) => {
          setDragging(null);
          perform(player.setVolume(value));
        }}
      />
    </div>
  );
}
