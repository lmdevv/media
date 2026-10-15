import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { Badge } from "@music/ui/components/badge";
import { DialogClose } from "@music/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@music/ui/components/popover";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import {
  ChevronDownIcon,
  ExpandIcon,
  ListMusicIcon,
  MessageCircleIcon,
  ShrinkIcon,
  Volume1Icon,
  Volume2Icon,
} from "lucide-react";
import { Match } from "effect";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import type { NowPlayingView } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { useArtColors } from "@/lib/use-art-colors";

import {
  PlayPauseButton,
  Progress,
  RepeatButton,
  ShuffleButton,
  SkipButton,
  Volume,
  deviceIcon,
  useIsRemote,
} from "./controls";
import { DeviceList } from "./devices";
import { nowPlayingBackground } from "./now-playing-background";
import { RemotePill } from "./now-playing-remote-pill";
import { UpcomingQueue, useClearQueue, useUpNext } from "./queue";

/** Translucent white fills on the always-dark Now Playing; `text` is white inside `.dark`. */
const glassButton =
  "flex shrink-0 items-center justify-center rounded-full bg-text/10 text-text outline-none hover:bg-text/16 focus-visible:ring-2 focus-visible:ring-ring/50";

interface DesktopNowPlayingProps {
  readonly track: Track;
  readonly view: NowPlayingView;
  readonly onView: (view: NowPlayingView | null) => void;
}

/**
 * Desktop Now Playing: the player, queue, and cover-only views (Paper 05 · 01, 01c, 01d) on the
 * radial art-tinted background. Lyrics are V1, so their button is shown but disabled.
 */
export function DesktopNowPlaying({ track, view, onView }: DesktopNowPlayingProps) {
  const player = usePlayer();
  const colors = useArtColors(track.artUrl, track.albumId);
  const background = nowPlayingBackground(colors, "radial");

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
              className="aspect-square w-now-playing-cover rounded-lg shadow-now-playing-art"
            />
            <div className="flex flex-col items-center gap-0.5 text-center">
              <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
                {track.title}
              </h2>
              <span className="font-sans text-md/base text-text-muted">{track.artist}</span>
            </div>
            <div className="flex w-140 max-w-full items-center gap-5">
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
            <div className="flex w-95 shrink-0 flex-col gap-5.5">
              <Artwork
                url={track.artUrl}
                seed={track.albumId}
                className="aspect-square w-full rounded-lg shadow-now-playing-art-sm"
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
                <PlayPauseButton className="size-15" iconClassName="size-5.5" />
                <SkipButton direction="next" iconClassName="size-7" />
                <RepeatButton iconClassName="size-5" />
              </div>
              <div className="flex items-center justify-center gap-2">
                <LyricsButton />
                <ViewButton label="Hide queue" active onClick={() => onView("player")}>
                  <ListMusicIcon className="size-4.5" />
                </ViewButton>
                <ViewButton label="Cover only" active={false} onClick={() => onView("cover")}>
                  <ExpandIcon className="size-4.5" />
                </ViewButton>
              </div>
            </div>
            <UpNext />
          </div>
        )),
        Match.when("player", () => (
          <div className="flex grow items-center gap-18 px-6 py-6">
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className="aspect-square w-now-playing-art rounded-lg shadow-now-playing-art"
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
                <ShuffleButton iconClassName="size-5.5" />
                <div className="flex items-center gap-row">
                  <SkipButton direction="previous" iconClassName="size-8" />
                  <PlayPauseButton className="size-19" iconClassName="size-7" />
                  <SkipButton direction="next" iconClassName="size-8" />
                </div>
                <RepeatButton iconClassName="size-5.5" />
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
                    <ListMusicIcon className="size-4.5" />
                  </ViewButton>
                  <ViewButton label="Cover only" active={false} onClick={() => onView("cover")}>
                    <ExpandIcon className="size-4.5" />
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
          <MessageCircleIcon className="size-4.5" />
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
        <Icon aria-hidden className="size-4.5" />
        {name}
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-95 gap-0.5 p-2">
        <span className="px-3 pt-2.5 pb-2 font-sans text-md/base font-semibold text-text">
          Play on
        </span>
        <DeviceList />
      </PopoverContent>
    </Popover>
  );
}

function UpNext() {
  const { queued, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  return (
    <div className="flex max-w-155 min-w-0 grow flex-col gap-7">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-xl leading-8.5 font-heavy tracking-tight text-text">
          Up next
        </h2>
        {queued.length > 0 ? (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clear()}
            className="rounded-full bg-text/8 px-3.5 py-1.75 font-sans text-sm/xs font-medium text-text/70 hover:bg-text/14 disabled:opacity-(--opacity-muted)"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-6">
        <UpcomingQueue
          tone="glass"
          heading={
            <span className="px-3 pb-1.5 font-sans text-xs/xs font-medium tracking-mono text-text/55 uppercase">
              {source === null ? "Next up" : `From ${source}`}
            </span>
          }
          empty={
            <p className="px-3 font-sans text-base/sm text-text/60">Nothing after this song.</p>
          }
        />
      </div>
    </div>
  );
}
