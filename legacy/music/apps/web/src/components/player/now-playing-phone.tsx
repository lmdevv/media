import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { DialogClose } from "@music/ui/components/dialog";
import { cn } from "@music/ui/lib/utils";
import { ListMusicIcon, MessageCircleIcon, MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import { LikeButton } from "@/components/library/like-button";
import { TrackMenu } from "@/components/playlists/track-menu";
import { PhonePauseGlyph, PhonePlayGlyph, PhoneSkipGlyph } from "@/components/shell/phone-chrome";
import { useUi } from "@/components/shell/ui-state";
import type { NowPlayingView } from "@/components/shell/ui-state";
import { formatQuality } from "@/lib/format";
import { useArtColors } from "@/lib/use-art-colors";

import { NEXT_REPEAT, Progress, Volume, perform, useIsRemote } from "./controls";
import { nowPlayingBackground } from "./now-playing-background";
import { AirPlayGlyph, RepeatGlyph, ShuffleGlyph } from "./now-playing-glyphs";
import { RemotePill } from "./now-playing-remote-pill";
import { UpcomingQueue, useUpNext } from "./queue";

interface PhoneNowPlayingProps {
  readonly track: Track;
  readonly view: NowPlayingView;
  readonly onView: (view: NowPlayingView | null) => void;
}

/**
 * Phone Now Playing: the full-screen player and queue (Paper 05 · 04, 04c) on the linear
 * art-tinted background, with the Play on sheet. Lyrics are V1, so their button is disabled.
 */
export function PhoneNowPlaying({ track, view, onView }: PhoneNowPlayingProps) {
  const player = usePlayer();
  const remote = useIsRemote();
  const colors = useArtColors(track.artUrl, track.albumId);
  const background = nowPlayingBackground(colors, "linear");
  const queue = view === "queue";
  const playing = player.status === "playing";

  const deviceName =
    remote && player.activeDevice !== null ? player.activeDevice.name : "This browser";

  return (
    <div
      className={cn(
        "flex flex-col px-5 pt-safe-top-sm pb-safe-bottom-lg",
        // The queue scrolls inside the screen so the transport stays pinned at the bottom (05 · 04c).
        queue ? "h-full" : "min-h-full",
      )}
      style={background}
    >
      <DialogClose
        aria-label="Close Now Playing"
        className="flex justify-center pt-1.5 pb-4.5 outline-none"
      >
        <span className="h-1.25 w-9 rounded-2xs bg-text/35" />
      </DialogClose>

      {queue ? (
        <>
          <div className="flex items-center gap-3 px-2">
            <Artwork
              url={track.artUrl}
              seed={track.albumId}
              className="size-row-touch rounded-sm shadow-now-playing-thumb"
            />
            <div className="flex min-w-0 grow flex-col">
              <span className="truncate font-sans text-phone-body leading-5.5 font-semibold text-text">
                {track.title}
              </span>
              <span className="truncate font-sans text-phone-body leading-5.5 text-text/60">
                {track.artist}
              </span>
            </div>
            <TrackMenu
              track={track}
              className="size-7.5 bg-text/14 hover:bg-text/20"
              trigger={<MoreHorizontalIcon className="size-4" />}
            />
          </div>
          <div className="flex gap-2 pt-5.5">
            <PillToggle
              label="Shuffle"
              pressed={player.shuffle}
              onClick={() => perform(player.setShuffle(!player.shuffle))}
            >
              <ShuffleGlyph />
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
            className="aspect-square w-full rounded-phone-art shadow-now-playing-art-phone"
          />
          <div className="flex items-center justify-between gap-3 pt-11">
            <div className="flex min-w-0 flex-col gap-px">
              <span className="truncate font-sans text-lg leading-6.25 font-semibold tracking-snug text-text">
                {track.title}
              </span>
              <span className="truncate font-sans text-lg leading-6.25 text-text/60">
                {track.artist}
              </span>
            </div>
            <div className="flex gap-3">
              <LikeButton track={track} className="size-7.5 bg-text/14" iconClassName="size-4" />
              <TrackMenu
                track={track}
                className="size-7.5 bg-text/14 hover:bg-text/20"
                trigger={<MoreHorizontalIcon className="size-4" />}
              />
            </div>
          </div>
          {remote ? (
            <div className="pt-4">
              <RemotePill />
            </div>
          ) : null}
          <div className="flex flex-col gap-2 pt-6.5">
            <Progress
              layout="stacked"
              remaining
              timeClassName="font-sans text-xs/xs font-semibold text-text/50"
              fillClassName="bg-text/85"
              trackClassName="h-1.75 bg-text/22"
              thumbClassName="hidden"
            />
            <div className="-mt-6.5 flex justify-center">
              <span className="rounded-xs bg-text/12 px-1.5 py-0.5 font-sans text-2xs leading-3.5 font-semibold text-text/75">
                {track.lossless ? "Lossless" : formatQuality(track)}
              </span>
            </div>
          </div>
          <PhoneTransport className="px-9 pt-6.5" big />
          <div className="flex items-center gap-3 pt-8.5">
            <Volume
              className="grow [&>button]:text-text/60"
              sliderClassName="grow"
              fillClassName="bg-text/85"
            />
          </div>
          <div className="grow" />
        </>
      )}

      {queue ? <PhoneTransport className="justify-center gap-row-touch pt-1 pb-5.5" /> : null}
      <div className="flex items-center justify-between px-7.5 pt-4">
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
        <PlayOnButton deviceName={deviceName} showName={!queue} />
        <button
          type="button"
          aria-label={queue ? "Hide queue" : "Queue"}
          aria-pressed={queue}
          onClick={() => onView(queue ? "player" : "queue")}
          className={cn(
            "flex size-row items-center justify-center rounded-full",
            queue ? "bg-text/90 text-text-inverse" : "text-text/75",
          )}
        >
          <ListMusicIcon className="size-6" />
        </button>
      </div>
      <span className="sr-only">{playing ? "Playing" : "Paused"}</span>
    </div>
  );
}

/** The AirPlay-style button; it opens the shared "Play on" sheet (`DeviceSheet`). */
function PlayOnButton({
  deviceName,
  showName,
}: {
  readonly deviceName: string;
  readonly showName: boolean;
}) {
  const { openPlayOn } = useUi();

  return (
    <button
      type="button"
      onClick={openPlayOn}
      className="flex flex-col items-center gap-0.75 text-text/75 outline-none"
      aria-label={`Play on another device. Now: ${deviceName}`}
    >
      <AirPlayGlyph />
      {showName ? (
        <span className="font-sans text-2xs leading-3.5 font-medium text-text/60">
          {deviceName}
        </span>
      ) : null}
    </button>
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
        <PhoneSkipGlyph direction="previous" className={big ? "h-7.5 w-11" : "h-6 w-8.5"} />
      </button>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => perform(player.togglePlay())}
        className="text-text"
      >
        {playing ? (
          <PhonePauseGlyph className={big ? "h-11 w-10" : "h-8.5 w-7.5"} />
        ) : (
          <PhonePlayGlyph className={big ? "h-11 w-10" : "h-8.5 w-7.5"} />
        )}
      </button>
      <button
        type="button"
        aria-label="Next"
        onClick={() => perform(player.next())}
        className="text-text"
      >
        <PhoneSkipGlyph direction="next" className={big ? "h-7.5 w-11" : "h-6 w-8.5"} />
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
        "flex h-8.5 grow basis-0 items-center justify-center rounded-full",
        pressed ? "bg-text/90 text-dark-art" : "bg-text/14 text-text",
      )}
    >
      {children}
    </button>
  );
}

function PhoneUpNext() {
  const { queued, source } = useUpNext();
  const [reordering, setReordering] = useState(false);

  return (
    <div className="flex min-h-0 grow flex-col pt-5.5">
      <div className="flex items-start justify-between gap-3 px-2 pb-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-sans text-phone-body leading-5.5 font-semibold text-text">
            Continue Playing
          </span>
          {source === null ? null : (
            <span className="truncate font-sans text-sm/sm text-text/55">From {source}</span>
          )}
        </span>
        {queued.length > 1 || reordering ? (
          <button
            type="button"
            aria-pressed={reordering}
            onClick={() => setReordering((on) => !on)}
            className="shrink-0 rounded-full bg-text/8 px-3.5 py-1.75 font-sans text-sm/xs font-medium text-text hover:bg-text/14"
          >
            {reordering ? "Done" : "Reorder"}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto overscroll-contain">
        <UpcomingQueue
          tone="glass"
          reorderMode={reordering}
          heading={null}
          empty={<p className="px-2 font-sans text-sm/sm text-text/60">Nothing after this song.</p>}
        />
      </div>
    </div>
  );
}
