import type { Track } from "@music/commands/models";
import { Badge } from "@music/ui/components/badge";
import { DialogClose } from "@music/ui/components/dialog";
import { Spinner } from "@music/ui/components/spinner";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { ChevronDownIcon, ListMusicIcon, MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { JamButton } from "@/components/jam/jam-band";
import { Artwork } from "@/components/library/artwork";
import type { NowPlayingView } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { useArtColors } from "@/lib/use-art-colors";

import { PlayPauseButton, Progress, RepeatButton, ShuffleButton, SkipButton } from "./controls";
import { lyricsButton, lyricsOffer } from "./lyrics";
import type { LyricsAnswer, LyricsOffer } from "./lyrics";
import { LyricsPane } from "./lyrics-view";
import { nowPlayingBackground } from "./now-playing-background";
import { UpcomingQueue, useClearQueue, useUpNext } from "./queue";

/** Translucent white fills on the always-dark Now Playing; `text` is white inside `.dark`. */
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
      className={cn(
        "flex flex-col px-12 pt-7 pb-row",
        // Only the queue or the lyrics scroll, so the player column stays put beside them (05 ·
        // 01c, 01b). Below 688px the whole view scrolls instead, with the column at its smallest
        // art.
        beside ? "h-full min-h-172" : "min-h-full",
      )}
      style={background}
    >
      <div className="flex h-row shrink-0 items-center justify-between">
        <DialogClose aria-label="Close Now Playing" className={cn(glassButton, "size-9")}>
          <ChevronDownIcon className="size-5" />
        </DialogClose>
        <span className="font-mono text-md/base font-semibold text-text">[music]</span>
      </div>

      {beside ? (
        // The column and the queue or lyrics are centred as one group, so a wide window keeps them
        // together in the middle instead of leaving the right side empty (ADS-165).
        <div className="flex min-h-0 grow justify-center gap-24 px-6 py-6">
          {/* Sized to the window height, so the whole column fits beside the scrolling list. */}
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
          {/* A fixed width, not the cover's, so a short window doesn't squeeze the slider away. */}
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

/**
 * Lyrics and queue toggles; with both off, Now Playing shows the cover. The lyrics toggle is dimmed
 * for a song without lyrics, unless they are open (they went away while shown).
 */
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

  // A disabled button gets no pointer events, so its tooltip hangs on a wrapper.
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
        <JamButton tone="glass" className="mr-2" />
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
