/**
 * The player on phones, as Paper's iOS artboards draw it: glass circle buttons, a centered
 * transport, Netflix-style brightness (left) and volume (right) sliders, and track pills
 * (07 · 10 iOS · Player).
 *
 * Web pages cannot change the screen's brightness, so the brightness slider dims the video itself;
 * iPhones keep the volume with their buttons, so the volume slider shows only where the page can
 * set it.
 */
import { Slider } from "@base-ui/react/slider";
import { PauseGlyph, PlayGlyph } from "@media/ui/components/icons";
import { Scrubber } from "@media/ui/components/player-controls";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import {
  CaptionsIcon,
  GalleryVerticalEndIcon,
  ListVideoIcon,
  SunIcon,
  Volume1Icon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

function GlassButton({
  className,
  ...props
}: ComponentProps<"button"> & { readonly "aria-label": string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-pill bg-text/18 text-text [&_svg]:size-4.5",
        className,
      )}
      {...props}
    />
  );
}

function SkipGlyph({ forward }: { readonly forward: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-9">
      <path
        d={forward ? "M21 12a9 9 0 1 1-3-6.7L21 8" : "M3 12a9 9 0 1 0 3-6.7L3 8"}
        className="stroke-current"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d={forward ? "M21 3v5h-5" : "M3 3v5h5"}
        className="stroke-current"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x={forward ? 11.5 : 12.5}
        y="15.2"
        textAnchor="middle"
        className="fill-current font-sans font-bold"
        fontSize="7"
      >
        10
      </text>
    </svg>
  );
}

function SideSlider({
  label,
  value,
  onChange,
  onCommit,
  icon,
  className,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly onCommit?: ((value: number) => void) | undefined;
  readonly icon: ReactNode;
  readonly className?: string;
}) {
  const [moving, setMoving] = useState<number | null>(null);
  const movingNow = useRef<number | null>(null);

  const move = (next: number | null): void => {
    movingNow.current = next;
    setMoving(next);
  };

  const settle = (): void => {
    const last = movingNow.current;

    if (last === null) return;
    move(null);
    onCommit?.(last);
  };

  const settleCut = useEffectEvent(settle);

  useEffect(() => {
    const cut = (): void => settleCut();

    window.addEventListener("blur", cut);

    return () => window.removeEventListener("blur", cut);
  }, []);

  return (
    <div className={cn("absolute top-25 flex w-9 flex-col items-center gap-3", className)}>
      <Slider.Root
        orientation="vertical"
        min={0}
        max={1}
        step={0.05}
        value={moving ?? value}
        onValueChange={(next) => {
          move(next);
          onChange(next);
        }}
        onValueCommitted={(next) => {
          move(null);
          onCommit?.(next);
        }}
        className="h-33"
      >
        <Slider.Control
          onPointerCancel={settle}
          className="flex h-full w-9 cursor-pointer touch-none justify-center"
        >
          <Slider.Track className="relative h-full w-1 rounded-bar bg-text/30">
            <Slider.Indicator className="w-1 rounded-bar bg-text" />
            <Slider.Thumb aria-label={label} className="size-4 rounded-pill opacity-0" />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      {icon}
    </div>
  );
}

/** A frosted pill under the scrubber: the subtitle or audio track playing, the chapter, or Episodes. */
export function TrackPill({
  icon,
  label,
  className,
  ...props
}: ComponentProps<"button"> & {
  readonly icon: "subtitles" | "audio" | "chapters" | "episodes";
  readonly label: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 cursor-pointer items-center gap-1.5 rounded-pill bg-text/18 px-3.5 font-sans text-label/caption font-semibold text-text [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {icon === "subtitles" ? <CaptionsIcon strokeWidth={1.75} aria-hidden /> : null}
      {icon === "audio" ? <Volume1Icon strokeWidth={1.75} aria-hidden /> : null}
      {icon === "chapters" ? <ListVideoIcon strokeWidth={1.75} aria-hidden /> : null}
      {icon === "episodes" ? <GalleryVerticalEndIcon strokeWidth={1.75} aria-hidden /> : null}
      {label}
    </button>
  );
}

/**
 * Paper 07 · 10: the landscape phone controls over the video.
 *
 * @param volume - The page's volume, or null where only the hardware buttons set it.
 * @param tracks - Track pills, usually wrapped in a track popover.
 * @param scrub - Thumbnails and chapter marks for the scrubber.
 */
export function PhoneControls({
  title,
  playing,
  position,
  duration,
  brightness,
  volume,
  tracks,
  onClose,
  onPlayPause,
  onSkip,
  onSeek,
  onSeekCommit,
  scrub,
  onBrightness,
  onVolume,
  onVolumeCommit,
}: {
  readonly title: string;
  readonly playing: boolean;
  readonly position: number;
  readonly duration: number;
  readonly brightness: number;
  readonly volume: number | null;
  readonly tracks: ReactNode;
  readonly onClose: () => void;
  readonly onPlayPause: () => void;
  readonly onSkip: (seconds: number) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSeekCommit: (seconds: number) => void;
  readonly scrub?: Pick<
    ComponentProps<typeof Scrubber>,
    "describe" | "chapters" | "preview" | "onPreviewStart"
  >;
  readonly onBrightness: (value: number) => void;
  readonly onVolume: (value: number) => void;
  /** Where the volume slider settled, which unmuting from silence returns to. */
  readonly onVolumeCommit: (value: number) => void;
}) {
  return (
    <div className="on-media absolute inset-0 bg-linear-to-b from-dark-bg/55 via-dark-bg/25 via-35% to-dark-bg/75 font-sans">
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-14 pt-5">
        <GlassButton aria-label="Close player" onClick={onClose} className="[&_svg]:size-4">
          <XIcon strokeWidth={2.25} aria-hidden />
        </GlassButton>
        <p className="pointer-events-none absolute inset-x-0 top-7 text-center text-body/5 font-semibold text-text">
          {title}
        </p>
      </div>
      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-16">
        <button
          type="button"
          aria-label="Back 10 seconds"
          className="cursor-pointer text-text"
          onClick={() => onSkip(-10)}
        >
          <SkipGlyph forward={false} />
        </button>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          className="cursor-pointer text-text [&_svg]:size-14"
          onClick={onPlayPause}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <button
          type="button"
          aria-label="Forward 10 seconds"
          className="cursor-pointer text-text"
          onClick={() => onSkip(10)}
        >
          <SkipGlyph forward />
        </button>
      </div>
      <SideSlider
        label="Brightness"
        value={brightness}
        onChange={onBrightness}
        icon={<SunIcon className="size-5 text-text" strokeWidth={1.75} aria-hidden />}
        className="left-14"
      />
      {volume === null ? null : (
        <SideSlider
          label="Volume"
          value={volume}
          onChange={onVolume}
          onCommit={onVolumeCommit}
          icon={<Volume2Icon className="size-5 text-text" strokeWidth={1.75} aria-hidden />}
          className="right-14"
        />
      )}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 px-14 pb-5.5">
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 font-mono text-caption/caption text-text">
            {formatTimecode(position)}
          </span>
          <Scrubber
            position={position}
            duration={duration}
            onSeek={onSeek}
            onSeekCommit={onSeekCommit}
            {...scrub}
          />
          <span className="w-16 shrink-0 text-right font-mono text-caption/caption text-text">
            {formatTimecode(position - duration)}
          </span>
        </div>
        <div className="flex justify-center gap-2">{tracks}</div>
      </div>
    </div>
  );
}
