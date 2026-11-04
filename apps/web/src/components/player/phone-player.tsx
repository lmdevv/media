/**
 * The player on phones, as Paper's iOS artboards draw it: glass circle buttons, a centered
 * transport, Netflix-style brightness (left) and volume (right) sliders, and track pills
 * (07 · 10 iOS · Player); and in portrait, the room under the video (08 · 08 iOS · Guest view).
 *
 * Web pages cannot change the screen's brightness, so the brightness slider dims the video itself;
 * iPhones keep the volume with their buttons, so the volume slider shows only where the page can
 * set it.
 */
import { Slider } from "@base-ui/react/slider";
import { PauseGlyph, PlayGlyph } from "@media/ui/components/icons";
import { Scrubber } from "@media/ui/components/player-controls";
import type { RoomMember } from "@media/ui/components/room-panel";
import { Avatar } from "@media/ui/components/avatar";
import { formatTimecode } from "@media/ui/lib/timecode";
import { cn } from "@media/ui/lib/utils";
import {
  CaptionsIcon,
  CastIcon,
  GalleryVerticalEndIcon,
  ListVideoIcon,
  LockIcon,
  LogOutIcon,
  Maximize2Icon,
  SunIcon,
  UsersIcon,
  Volume1Icon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";

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
 * @param locked - For room guests: replaces the transport with who hosts, and the scrubber with a
 *   bar that cannot be moved.
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
  locked,
  onClose,
  onPlayPause,
  onSkip,
  onSeek,
  onSeekCommit,
  scrub,
  onBrightness,
  onVolume,
  onVolumeCommit,
  onRoom,
  castMenu,
}: {
  readonly title: string;
  readonly playing: boolean;
  readonly position: number;
  readonly duration: number;
  readonly brightness: number;
  readonly volume: number | null;
  readonly tracks: ReactNode;
  readonly locked?: string | undefined;
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
  readonly onRoom?: (() => void) | undefined;
  /** Wraps the cast button in the cast menu, where this browser can play elsewhere. */
  readonly castMenu?: ((trigger: ReactElement) => ReactNode) | undefined;
}) {
  const fraction = duration <= 0 ? 0 : Math.min(1, position / duration);

  return (
    <div className="on-media absolute inset-0 bg-linear-to-b from-dark-bg/55 via-dark-bg/25 via-35% to-dark-bg/75 font-sans">
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-14 pt-5">
        <GlassButton aria-label="Close player" onClick={onClose} className="[&_svg]:size-4">
          <XIcon strokeWidth={2.25} aria-hidden />
        </GlassButton>
        <p className="pointer-events-none absolute inset-x-0 top-7 text-center text-body/5 font-semibold text-text">
          {title}
        </p>
        <div className="relative flex gap-2.5">
          {onRoom === undefined ? null : (
            <GlassButton aria-label="Watch together" onClick={onRoom}>
              <UsersIcon strokeWidth={1.75} aria-hidden />
            </GlassButton>
          )}
          {castMenu?.(
            <GlassButton aria-label="Cast">
              <CastIcon strokeWidth={1.75} aria-hidden />
            </GlassButton>,
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-16">
        {locked === undefined ? (
          <>
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
          </>
        ) : (
          <span className="flex h-7 items-center gap-1.5 rounded-pill bg-dark-bg/45 pr-2.5 pl-2 text-caption/caption font-semibold text-text">
            <LockIcon className="size-3.5" strokeWidth={2} aria-hidden />
            {locked}
          </span>
        )}
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
          {locked === undefined ? (
            <Scrubber
              position={position}
              duration={duration}
              onSeek={onSeek}
              onSeekCommit={onSeekCommit}
              {...scrub}
            />
          ) : (
            <div className="flex h-1 grow items-center rounded-bar bg-text/30">
              <div
                className="h-1 rounded-bar bg-accent"
                style={{ width: `${String(fraction * 100)}%` }}
              />
            </div>
          )}
          <span className="w-16 shrink-0 text-right font-mono text-caption/caption text-text">
            {formatTimecode(position - duration)}
          </span>
        </div>
        <div className="flex justify-center gap-2">{tracks}</div>
      </div>
    </div>
  );
}

/**
 * Paper 08 · 08: the room under the video on a phone held upright: live position, the title, who
 * is watching, and Subtitles and Leave room at the bottom.
 */
export function PhoneRoomDetails({
  live,
  position,
  duration,
  title,
  members,
  subtitles,
  onLeave,
}: {
  readonly live: boolean;
  readonly position: number;
  readonly duration: number;
  readonly title: string;
  readonly members: ReadonlyArray<RoomMember>;
  /** The Subtitles button, usually a track popover trigger. */
  readonly subtitles: ReactElement;
  readonly onLeave: () => void;
}) {
  return (
    <div className="on-media flex grow flex-col font-sans">
      <div className="flex flex-col gap-2.5 px-5 pt-6 pb-2">
        <p className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-5.5 items-center gap-1.5 rounded-pill px-2 text-micro/3.5 font-bold tracking-caps text-on-accent uppercase",
              live ? "bg-accent" : "bg-text/18",
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-pill", live ? "bg-on-accent" : "bg-warning")}
            />
            {live ? "Live" : "Paused"}
          </span>
          <span className="font-mono text-caption/caption text-text-muted">
            {formatTimecode(position)} / {formatTimecode(duration)}
          </span>
        </p>
        <h1 className="text-search/8 font-heavy tracking-tight text-text">{title}</h1>
      </div>
      <section aria-label="In the room" className="flex flex-col gap-2 px-4 pt-5">
        <h2 className="px-1 text-label/label font-semibold text-text-muted">In the room</h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 py-2">
              <Avatar
                name={member.name}
                image={member.avatar}
                round
                className={cn("size-9", member.status?.kind === "left" && "opacity-35")}
              />
              <span className="flex grow basis-0 flex-col">
                <span className="text-body/5 font-semibold text-text">{member.name}</span>
                {member.detail === undefined ? null : (
                  <span className="text-label/label text-text-muted">{member.detail}</span>
                )}
              </span>
              {member.status === undefined ? null : (
                <span
                  className={cn(
                    "w-16 shrink-0 text-right font-mono text-caption/caption",
                    member.status.kind === "away" ? "text-text-muted" : "text-warning",
                  )}
                >
                  {member.status.kind === "drift" ? member.status.label : member.status.kind}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <div className="mt-auto flex gap-3 px-5 pt-4 pb-[max(env(safe-area-inset-bottom),var(--spacing-5))]">
        {subtitles}
        <button
          type="button"
          onClick={onLeave}
          className="flex h-12 grow basis-0 cursor-pointer items-center justify-center gap-2 rounded-pill bg-text/18 text-button/5 font-semibold text-text [&_svg]:size-4.5"
        >
          <LogOutIcon strokeWidth={1.75} aria-hidden />
          Leave room
        </button>
      </div>
    </div>
  );
}

/** The frosted Subtitles pill of the portrait room view. */
export function PhoneSubtitlesButton(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="flex h-12 grow basis-0 cursor-pointer items-center justify-center gap-2 rounded-pill bg-text/18 font-sans text-button/5 font-semibold text-text [&_svg]:size-4.5"
      {...props}
    >
      <CaptionsIcon strokeWidth={1.75} aria-hidden />
      Subtitles
    </button>
  );
}

/** The video overlays of the portrait room view: who hosts, and full screen. */
export function PhoneRoomVideoChrome({
  hostName,
  fraction,
  onFullscreen,
}: {
  readonly hostName: string;
  readonly fraction: number;
  readonly onFullscreen: () => void;
}) {
  return (
    <div className="on-media pointer-events-none absolute inset-0 bg-linear-to-b from-transparent from-45% to-dark-bg/60 font-sans">
      <span className="absolute bottom-4 left-3 flex h-7 items-center gap-1.5 rounded-pill bg-dark-bg/45 pr-2.5 pl-2 text-caption/caption font-semibold text-text">
        <LockIcon className="size-3.25" strokeWidth={2} aria-hidden />
        {hostName} is hosting
      </span>
      <button
        type="button"
        aria-label="Full screen"
        onClick={onFullscreen}
        className="pointer-events-auto absolute right-3 bottom-4 flex size-7 cursor-pointer items-center justify-center rounded-pill bg-dark-bg/45 text-text"
      >
        <Maximize2Icon className="size-3.5" strokeWidth={2} aria-hidden />
      </button>
      <div className="absolute inset-x-0 bottom-0 flex h-0.75 bg-text/25">
        <div className="h-0.75 bg-accent" style={{ width: `${String(fraction * 100)}%` }} />
      </div>
    </div>
  );
}
