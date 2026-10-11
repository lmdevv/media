import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { Badge } from "@music/ui/components/badge";
import { Dialog, DialogClose, DialogPopup, DialogPortal } from "@music/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@music/ui/components/popover";
import { Sheet, SheetContent } from "@music/ui/components/sheet";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { useLocation } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ExpandIcon,
  ListMusicIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  ShrinkIcon,
  Volume1Icon,
  Volume2Icon,
} from "lucide-react";
import { Match } from "effect";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import { LikeButton } from "@/components/library/like-button";
import { TrackMenu } from "@/components/playlists/track-menu";
import { PhonePauseGlyph, PhonePlayGlyph, PhoneSkipGlyph } from "@/components/shell/phone-chrome";
import { useUi } from "@/components/shell/ui-state";
import type { NowPlayingView } from "@/components/shell/ui-state";
import { artTint } from "@/lib/art";
import { formatQuality } from "@/lib/format";
import { useArtColors } from "@/lib/use-art-colors";

import {
  NEXT_REPEAT,
  PlayPauseButton,
  Progress,
  RepeatButton,
  ShuffleButton,
  SkipButton,
  Volume,
  deviceIcon,
  perform,
  useIsRemote,
} from "./controls";
import { DeviceList } from "./devices";
import { QueueRow, useClearQueue, useUpNext } from "./queue";

/** Translucent white fills on the always-dark Now Playing; `text` is white inside `.dark`. */
const glassButton =
  "flex shrink-0 items-center justify-center rounded-full bg-text/10 text-text outline-none hover:bg-text/16 focus-visible:ring-2 focus-visible:ring-ring/50";

const useBackground = (track: Track, layout: "radial" | "linear"): CSSProperties => {
  const [light, deep] = useArtColors(track.artUrl, track.albumId);
  const glow = artTint(light, "light");
  const shade = artTint(deep, "deep");

  return {
    backgroundImage:
      layout === "radial"
        ? `radial-gradient(ellipse 110% 90% at 22% 35% in oklab, ${glow} 0%, ${shade} 55%, var(--color-dark-bg) 100%)`
        : `linear-gradient(in oklab 180deg, ${glow} 0%, ${shade} 60%, var(--color-dark-bg) 100%)`,
  };
};

/**
 * Now Playing, always on the art-tinted dark background. Desktop has the player, queue, and
 * cover-only views (Paper 05 · 01, 01c, 01d); phones get the full-screen player and queue
 * (05 · 04, 04c). Lyrics are V1, so their button is shown but disabled.
 */
export function NowPlaying() {
  const { nowPlaying, setNowPlaying } = useUi();
  const player = usePlayer();
  const location = useLocation();

  useEffect(() => {
    setNowPlaying(null);
  }, [location.pathname, setNowPlaying]);

  const open = nowPlaying !== null && player.track !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : setNowPlaying(null))}>
      <DialogPortal>
        <DialogPopup
          aria-label="Now Playing"
          className="dark fixed inset-0 z-50 overflow-y-auto bg-dark-bg text-text outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-8 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-8"
        >
          {nowPlaying !== null && player.track !== null ? (
            <>
              <div className="hidden h-full lg:block">
                <DesktopNowPlaying track={player.track} view={nowPlaying} onView={setNowPlaying} />
              </div>
              <div className="h-full lg:hidden">
                <PhoneNowPlaying track={player.track} view={nowPlaying} onView={setNowPlaying} />
              </div>
            </>
          ) : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

interface ViewProps {
  readonly track: Track;
  readonly view: NowPlayingView;
  readonly onView: (view: NowPlayingView | null) => void;
}

function LyricsButton({ className }: { readonly className?: string }) {
  return (
    <Tooltip label="Lyrics are coming in a later version">
      <span>
        <button
          type="button"
          aria-label="Lyrics (coming later)"
          disabled
          className={cn(glassButton, "size-9 opacity-(--opacity-disabled)", className)}
        >
          <MessageCircleIcon className="size-[18px]" />
        </button>
      </span>
    </Tooltip>
  );
}

function ViewButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(glassButton, "size-9", active && "bg-text text-text-inverse hover:bg-text")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function RemotePill() {
  const player = usePlayer();
  const remote = useIsRemote();

  if (!remote || player.activeDevice === null) return null;

  const Icon = deviceIcon(player.activeDevice.kind);

  return (
    <span
      role="status"
      className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-accent px-3 font-sans text-sm/xs font-semibold text-on-accent"
    >
      <Icon aria-hidden className="size-3.5" />
      Playing on {player.activeDevice.name}
    </span>
  );
}

function DesktopNowPlaying({ track, view, onView }: ViewProps) {
  const player = usePlayer();
  const background = useBackground(track, "radial");

  return (
    <div className="flex min-h-full flex-col px-12 pt-7 pb-row" style={background}>
      <div className="flex h-row shrink-0 items-center justify-between">
        <DialogClose aria-label="Close Now Playing" className={cn(glassButton, "size-9")}>
          <ChevronDownIcon className="size-5" />
        </DialogClose>
        <span className="font-mono text-md/base font-semibold text-text">[music]</span>
      </div>

      {Match.value(view).pipe(
        Match.when("cover", () => (
          <div className="flex grow flex-col items-center justify-center gap-7 py-6">
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className="aspect-square w-[min(560px,58vh)] rounded-lg shadow-[0_40px_80px_rgb(0_0_0/45%)]"
            />
            <div className="flex flex-col items-center gap-0.5 text-center">
              <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
                {track.title}
              </h2>
              <span className="font-sans text-md/base text-text-muted">{track.artist}</span>
            </div>
            <div className="flex w-[560px] max-w-full items-center gap-5">
              <Progress
                remaining
                timeClassName="w-10 font-mono text-xs/xs text-text-muted"
                fillClassName="bg-text"
                trackClassName="bg-text/16"
                thumbClassName="bg-text"
              />
              <PlayPauseButton tone="glass" iconClassName="size-4" />
              <ViewButton label="Exit cover view" active onClick={() => onView("player")}>
                <ShrinkIcon className="size-4" />
              </ViewButton>
            </div>
          </div>
        )),
        Match.when("queue", () => (
          <div className="flex grow items-center gap-24 px-6 py-6">
            <div className="flex w-[380px] shrink-0 flex-col gap-[22px]">
              <Artwork
                url={track.artUrl}
                seed={track.albumId}
                className="aspect-square w-full rounded-lg shadow-[0_32px_64px_rgb(0_0_0/45%)]"
              />
              <div className="flex items-end justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 className="truncate font-sans text-xl/xl font-heavy tracking-tight text-text">
                    {track.title}
                  </h2>
                  <span className="truncate font-sans text-md/base text-text-muted">
                    {track.artist}
                  </span>
                </div>
                <Badge tone="accent">{formatQuality(track)}</Badge>
              </div>
              <Progress
                layout="stacked"
                remaining
                timeClassName="font-mono text-xs/xs text-text-muted"
                fillClassName="bg-text"
                trackClassName="bg-text/18"
                thumbClassName="bg-text"
              />
              <div className="flex items-center justify-between">
                <ShuffleButton iconClassName="size-5" />
                <SkipButton direction="previous" iconClassName="size-7" />
                <PlayPauseButton className="size-[60px]" iconClassName="size-[22px]" />
                <SkipButton direction="next" iconClassName="size-7" />
                <RepeatButton iconClassName="size-5" />
              </div>
              <div className="flex items-center justify-center gap-2">
                <LyricsButton />
                <ViewButton label="Hide queue" active onClick={() => onView("player")}>
                  <ListMusicIcon className="size-[18px]" />
                </ViewButton>
                <ViewButton label="Cover only" active={false} onClick={() => onView("cover")}>
                  <ExpandIcon className="size-[18px]" />
                </ViewButton>
              </div>
            </div>
            <UpNext />
          </div>
        )),
        Match.when("player", () => (
          <div className="flex grow items-center gap-[72px] px-6 py-6">
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className="aspect-square w-[min(520px,42vw,62vh)] rounded-lg shadow-[0_40px_80px_rgb(0_0_0/45%)]"
            />
            <div className="flex min-w-0 grow flex-col gap-9">
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5">
                  <Badge tone="accent">{formatQuality(track)}</Badge>
                  <RemotePill />
                </div>
                <h2 className="font-sans text-2xl/2xl font-heavy tracking-display text-balance text-text xl:text-display/display">
                  {track.title}
                </h2>
                <span className="font-sans text-lg/lg text-text-muted">
                  {track.artist} · {track.album}
                </span>
              </div>
              <Progress
                layout="stacked"
                remaining
                timeClassName="font-mono text-sm/xs text-text-muted"
                fillClassName="bg-text"
                trackClassName="bg-text/16"
                thumbClassName="bg-text opacity-100"
              />
              <div className="flex items-center justify-between">
                <ShuffleButton iconClassName="size-[22px]" />
                <div className="flex items-center gap-row">
                  <SkipButton direction="previous" iconClassName="size-8" />
                  <PlayPauseButton className="size-[76px]" iconClassName="size-7" />
                  <SkipButton direction="next" iconClassName="size-8" />
                </div>
                <RepeatButton iconClassName="size-[22px]" />
              </div>
              <div className="flex items-center gap-5">
                <Volume1Icon aria-hidden className="size-5 text-text-muted" />
                <Volume
                  className="grow [&>button]:hidden"
                  sliderClassName="grow"
                  fillClassName="bg-text-muted"
                />
                <Volume2Icon aria-hidden className="size-5 text-text-muted" />
                <span aria-hidden className="h-5 w-px shrink-0 bg-text/16" />
                <DevicePill />
                <div className="flex items-center gap-2">
                  <LyricsButton />
                  <ViewButton label="Queue" active={false} onClick={() => onView("queue")}>
                    <ListMusicIcon className="size-[18px]" />
                  </ViewButton>
                  <ViewButton label="Cover only" active={false} onClick={() => onView("cover")}>
                    <ExpandIcon className="size-[18px]" />
                  </ViewButton>
                </div>
              </div>
              <span className="sr-only">{player.status}</span>
            </div>
          </div>
        )),
        Match.exhaustive,
      )}
    </div>
  );
}

function DevicePill() {
  const player = usePlayer();
  const remote = useIsRemote();
  const Icon = deviceIcon(player.activeDevice?.kind ?? "web");
  const name = remote && player.activeDevice !== null ? player.activeDevice.name : "This browser";

  return (
    <Popover>
      <PopoverTrigger
        className={cn(glassButton, "h-9 gap-2 px-3.5 font-sans text-sm/xs font-medium")}
      >
        <Icon aria-hidden className="size-[18px]" />
        {name}
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[380px] gap-0.5 p-2">
        <span className="px-3 pt-2.5 pb-2 font-sans text-md/base font-semibold text-text">
          Play on
        </span>
        <DeviceList />
      </PopoverContent>
    </Popover>
  );
}

function UpNext() {
  const { next, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  return (
    <div className="flex max-w-[620px] min-w-0 grow flex-col gap-7">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-xl leading-[34px] font-heavy tracking-tight text-text">
          Up next
        </h2>
        {next.length > 0 ? (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clear()}
            className="rounded-full bg-text/8 px-3.5 py-[7px] font-sans text-sm/xs font-medium text-text/70 hover:bg-text/14 disabled:opacity-(--opacity-muted)"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <span className="px-3 pb-1.5 font-sans text-xs/xs font-medium tracking-mono text-text/55 uppercase">
          {source === null ? "Next up" : `From ${source}`}
        </span>
        {next.length === 0 ? (
          <p className="px-3 font-sans text-base/sm text-text/60">Nothing after this song.</p>
        ) : (
          next.map((entry) => (
            <QueueRow
              key={`${entry.index}-${entry.track.id}`}
              track={entry.track}
              index={entry.index}
              tone="glass"
            />
          ))
        )}
      </div>
    </div>
  );
}

function PhoneNowPlaying({ track, view, onView }: ViewProps) {
  const player = usePlayer();
  const remote = useIsRemote();
  const background = useBackground(track, "linear");
  const [sheet, setSheet] = useState(false);
  const queue = view === "queue";
  const playing = player.status === "playing";

  const deviceName =
    remote && player.activeDevice !== null ? player.activeDevice.name : "This browser";

  return (
    <div
      className={cn(
        "flex flex-col px-5 pt-[max(12px,env(safe-area-inset-top))] pb-[max(30px,env(safe-area-inset-bottom))]",
        // The queue scrolls inside the screen so the transport stays pinned at the bottom (05 · 04c).
        queue ? "h-full" : "min-h-full",
      )}
      style={background}
    >
      <DialogClose
        aria-label="Close Now Playing"
        className="flex justify-center pt-1.5 pb-[18px] outline-none"
      >
        <span className="h-[5px] w-9 rounded-[3px] bg-text/35" />
      </DialogClose>

      {queue ? (
        <>
          <div className="flex items-center gap-3 px-2">
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className="size-row-touch rounded-sm shadow-[0_6px_14px_rgb(0_0_0/35%)]"
            />
            <div className="flex min-w-0 grow flex-col">
              <span className="truncate font-sans text-[17px] leading-[22px] font-semibold text-text">
                {track.title}
              </span>
              <span className="truncate font-sans text-[17px] leading-[22px] text-text/60">
                {track.artist}
              </span>
            </div>
            <TrackMenu
              track={track}
              className="size-[30px] bg-text/14 hover:bg-text/20"
              trigger={<MoreHorizontalIcon className="size-4" />}
            />
          </div>
          <div className="flex gap-2 pt-[22px]">
            <PillToggle
              label="Shuffle"
              pressed={player.shuffle}
              onClick={() => perform(player.setShuffle(!player.shuffle))}
            >
              <ShuffleButtonGlyph />
            </PillToggle>
            <PillToggle
              label={player.repeat === "one" ? "Repeat one" : "Repeat"}
              pressed={player.repeat !== "off"}
              onClick={() => perform(player.setRepeat(NEXT_REPEAT[player.repeat]))}
            >
              <RepeatGlyph one={player.repeat === "one"} />
            </PillToggle>
          </div>
          <PhoneUpNext />
        </>
      ) : (
        <>
          <Artwork
            url={track.artUrl}
            seed={track.albumId}
            className="aspect-square w-full rounded-[10px] shadow-[0_24px_48px_rgb(0_0_0/40%)]"
          />
          <div className="flex items-center justify-between gap-3 pt-11">
            <div className="flex min-w-0 flex-col gap-px">
              <span className="truncate font-sans text-lg leading-[25px] font-semibold tracking-[-0.01em] text-text">
                {track.title}
              </span>
              <span className="truncate font-sans text-lg leading-[25px] text-text/60">
                {track.artist}
              </span>
            </div>
            <div className="flex gap-3">
              <LikeButton track={track} className="size-[30px] bg-text/14" iconClassName="size-4" />
              <TrackMenu
                track={track}
                className="size-[30px] bg-text/14 hover:bg-text/20"
                trigger={<MoreHorizontalIcon className="size-4" />}
              />
            </div>
          </div>
          {remote ? (
            <div className="pt-4">
              <RemotePill />
            </div>
          ) : null}
          <div className="flex flex-col gap-2 pt-[26px]">
            <Progress
              layout="stacked"
              remaining
              timeClassName="font-sans text-xs/xs font-semibold text-text/50"
              fillClassName="bg-text/85"
              trackClassName="h-[7px] bg-text/22"
              thumbClassName="hidden"
            />
            <div className="-mt-[26px] flex justify-center">
              <span className="rounded-[4px] bg-text/12 px-1.5 py-0.5 font-sans text-[11px] leading-[14px] font-semibold text-text/75">
                {track.lossless ? "Lossless" : formatQuality(track)}
              </span>
            </div>
          </div>
          <PhoneTransport className="px-9 pt-[26px]" big />
          <div className="flex items-center gap-3 pt-[34px]">
            <Volume
              className="grow [&>button]:text-text/60"
              sliderClassName="grow"
              fillClassName="bg-text/85"
            />
          </div>
          <div className="grow" />
        </>
      )}

      {queue ? <PhoneTransport className="justify-center gap-row-touch pt-1 pb-[22px]" /> : null}
      <div className="flex items-center justify-between px-[30px] pt-4">
        <span>
          <button
            type="button"
            disabled
            aria-label="Lyrics (coming later)"
            className="flex size-row items-center justify-center text-text/75 opacity-(--opacity-disabled)"
          >
            <MessageCircleIcon className="size-6" />
          </button>
        </span>
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="flex flex-col items-center gap-[3px] text-text/75 outline-none"
          aria-label={`Play on another device. Now: ${deviceName}`}
        >
          <AirPlayGlyph />
          {queue ? null : (
            <span className="font-sans text-[11px] leading-[14px] font-medium text-text/60">
              {deviceName}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-label={queue ? "Hide queue" : "Queue"}
          aria-pressed={queue}
          onClick={() => onView(queue ? "player" : "queue")}
          className={cn(
            "flex size-row items-center justify-center rounded-[20px]",
            queue ? "bg-text/90 text-text-inverse" : "text-text/75",
          )}
        >
          <ListMusicIcon className="size-6" />
        </button>
      </div>
      <span className="sr-only">{playing ? "Playing" : "Paused"}</span>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent title="Play on" description={`${track.title} · ${track.artist}`}>
          <DeviceList touch />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PhoneTransport({
  className,
  big = false,
}: {
  readonly className?: string;
  readonly big?: boolean;
}) {
  const player = usePlayer();
  const playing = player.status === "playing";

  return (
    <div className={cn("flex items-center justify-between", className)}>
      <button
        type="button"
        aria-label="Previous"
        onClick={() => perform(player.previous())}
        className="text-text"
      >
        <PhoneSkipGlyph direction="previous" className={big ? "h-[30px] w-11" : "h-6 w-[34px]"} />
      </button>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => perform(player.togglePlay())}
        className="text-text"
      >
        {playing ? (
          <PhonePauseGlyph className={big ? "h-11 w-10" : "h-[34px] w-[30px]"} />
        ) : (
          <PhonePlayGlyph className={big ? "h-11 w-10" : "h-[34px] w-[30px]"} />
        )}
      </button>
      <button
        type="button"
        aria-label="Next"
        onClick={() => perform(player.next())}
        className="text-text"
      >
        <PhoneSkipGlyph direction="next" className={big ? "h-[30px] w-11" : "h-6 w-[34px]"} />
      </button>
    </div>
  );
}

function PillToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex h-[34px] grow basis-0 items-center justify-center rounded-[17px]",
        pressed ? "bg-text/90 text-dark-art" : "bg-text/14 text-text",
      )}
    >
      {children}
    </button>
  );
}

function ShuffleButtonGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="m18 14 4 4-4 4" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
      <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
    </svg>
  );
}

function RepeatGlyph({ one }: { readonly one: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      {one ? <path d="M11 10h1v4" /> : null}
    </svg>
  );
}

function AirPlayGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-6"
    >
      <path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1" />
      <path d="m12 15 5 6H7Z" />
    </svg>
  );
}

function PhoneUpNext() {
  const { next, source } = useUpNext();

  return (
    <div className="flex min-h-0 grow flex-col pt-[22px]">
      <div className="flex flex-col px-2 pb-2">
        <span className="font-sans text-[17px] leading-[22px] font-semibold text-text">
          Continue Playing
        </span>
        {source === null ? null : (
          <span className="font-sans text-sm/sm text-text/55">From {source}</span>
        )}
      </div>
      {next.length === 0 ? (
        <p className="px-2 font-sans text-sm/sm text-text/60">Nothing after this song.</p>
      ) : (
        <div className="min-h-0 grow overflow-y-auto overscroll-contain">
          {next.map((entry) => (
            <QueueRow
              key={`${entry.index}-${entry.track.id}`}
              track={entry.track}
              index={entry.index}
              tone="glass"
            />
          ))}
        </div>
      )}
    </div>
  );
}
