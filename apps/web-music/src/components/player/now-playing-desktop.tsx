import type { Track } from "@/lib/models";
import { lyricsButton, lyricsOffer } from "@media/player/lyrics";
import type { LyricsAnswer, LyricsOffer } from "@media/player/lyrics";
import { Badge } from "@/components/ui/badge";
import { DialogClose } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ListMusicIcon, MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import type { NowPlayingView } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { useArtColors } from "@/lib/use-art-colors";

import { PlayPauseButton, Progress, RepeatButton, ShuffleButton, SkipButton } from "./controls";
import { LyricsPane } from "./lyrics-view";
import { nowPlayingBackground } from "./now-playing-background";
import { UpcomingQueue, useClearQueue, useUpNext } from "./queue";

const glassButton =
  "flex shrink-0 items-center justify-center rounded-full bg-text/10 text-text outline-none hover:bg-text/16 focus-visible:ring-2 focus-visible:ring-ring/50";

interface DesktopNowPlayingProps {
  readonly track: Track;
  /** `lyrics.get`'s answer for `track`. */
  readonly lyrics: LyricsAnswer;
  readonly view: NowPlayingView;
  readonly onView: (view: NowPlayingView | null) => void;
}

/**
 * Desktop Now Playing on the radial art-tinted background: the cover first (Paper 05 · 01), and
 * the queue (05 · 01c) or the lyrics (05 · 01b) beside the player when their toggle is on.
 */
export function DesktopNowPlaying({ track, lyrics, view, onView }: DesktopNowPlayingProps) {
  const colors = useArtColors(track.artUrl, track.albumId);
  const background = nowPlayingBackground(colors, "radial");
  const offer = lyricsOffer(lyrics);
  const beside = view !== "player";

  return (
    <div
      className={cn("flex flex-col px-12 pt-7 pb-row", beside ? "h-full min-h-172" : "min-h-full")}
      style={background}
    >
      <div className="flex h-row shrink-0 items-center">
        <DialogClose aria-label="Close Now Playing" className={cn(glassButton, "size-9")}>
          <ChevronDownIcon className="size-5" />
        </DialogClose>
      </div>

      {beside ? (
        <div className="flex min-h-0 grow justify-center gap-24 px-6 py-6">
          <div className="flex w-now-playing-queue-art shrink-0 flex-col gap-5.5 self-center-safe">
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
            <ViewToggles view={view} offer={offer} onView={onView} />
          </div>
          {view === "queue" ? (
            <UpNext />
          ) : (
            <LyricsPane
              key={track.id}
              lyrics={lyrics}
              layout="desktop"
              className="max-w-155 grow"
            />
          )}
        </div>
      ) : (
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
          <div className="flex w-140 max-w-full items-center gap-4">
            <Progress
              remaining
              className="min-w-0 grow gap-4"
              timeClassName="w-11 font-mono text-xs/xs text-text-muted"
              fillClassName="bg-text"
              trackClassName="bg-text/16"
              thumbClassName="bg-text"
            />
            <div className="flex shrink-0 items-center gap-3">
              <SkipButton direction="previous" className="size-9" iconClassName="size-4.5" />
              <PlayPauseButton iconClassName="size-4" />
              <SkipButton direction="next" className="size-9" iconClassName="size-4.5" />
            </div>
            <ViewToggles view={view} offer={offer} onView={onView} />
          </div>
        </div>
      )}
    </div>
  );
}

function ViewToggles({
  view,
  offer,
  onView,
}: {
  readonly view: NowPlayingView;
  readonly offer: LyricsOffer;
  readonly onView: (view: NowPlayingView) => void;
}) {
  const lyrics = view === "lyrics";
  const queue = view === "queue";
  const button = lyricsButton(offer, lyrics);

  return (
    <div className="flex shrink-0 items-center justify-center gap-2">
      <ViewButton
        label={button.label}
        active={lyrics}
        disabled={button.disabled}
        onClick={() => onView(lyrics ? "player" : "lyrics")}
      >
        {button.loading ? (
          <Spinner label="Looking for lyrics" className="size-4.5" />
        ) : (
          <MessageCircleIcon className="size-4.5" />
        )}
      </ViewButton>
      <ViewButton
        label={queue ? "Hide queue" : "Queue"}
        active={queue}
        onClick={() => onView(queue ? "player" : "queue")}
      >
        <ListMusicIcon className="size-4.5" />
      </ViewButton>
    </div>
  );
}

function ViewButton({
  label,
  active,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        glassButton,
        "size-9",
        active && "bg-text text-text-inverse hover:bg-text",
        disabled && "opacity-(--opacity-disabled) hover:bg-text/10",
      )}
    >
      {children}
    </button>
  );

  return <Tooltip label={label}>{disabled ? <span>{button}</span> : button}</Tooltip>;
}

function UpNext() {
  const { queued, source } = useUpNext();
  const [clear, clearing] = useClearQueue();

  return (
    <div className="flex max-w-155 min-w-0 grow flex-col justify-center gap-7">
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="grow font-sans text-xl leading-8.5 font-heavy tracking-tight text-text">
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
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto overscroll-contain">
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
