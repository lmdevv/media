import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { TrackMenu } from "@/components/playlists/track-menu";
import { formatDuration, formatQuality } from "@/lib/format";

import { Artwork, PlayingBars } from "./artwork";
import { usePlayTracks } from "./cards";
import { LikeButton } from "./like-button";

/**
 * `album` is the numbered Apple-style list (album detail); `list` is the songs table with covers,
 * album, and format columns (Songs, playlists, Liked songs).
 */
export type TrackListVariant = "album" | "list";

const headerCell = "font-mono text-xs/xs tracking-mono text-text-muted";

/** The row box both playable and unavailable songs use, so the two stay the same size. */
const rowClassName = (variant: TrackListVariant): string =>
  cn(
    "group/row relative flex shrink-0 items-center rounded-sm select-none",
    "h-12 border-t-[0.5px] border-border pr-1 lg:gap-3 lg:border-t-0 lg:px-2",
    variant === "album" ? "lg:h-row" : "gap-3 lg:h-[52px]",
    "hover:bg-surface has-[[data-popup-open]]:bg-surface",
  );

/** The track number column of the album variant. */
const numberCell = "w-[30px] shrink-0 lg:w-7";

/** A song's cover in the list variant. */
const coverClassName = "size-11 rounded-[4px] lg:size-row";

/** The format column of the list variant. */
const formatCell = "hidden w-[110px] shrink-0 font-mono text-xs/xs text-text-muted lg:block";

/**
 * Plays a song from a list on double click (desktop) or tap (phone), queueing the list's songs
 * that can play.
 */
const useRowPlay = (
  tracks: ReadonlyArray<Track>,
  unavailable: ((index: number) => boolean) | undefined,
) => {
  const play = usePlayTracks();

  return (index: number) => {
    if (unavailable === undefined) {
      void play(tracks, { index });

      return;
    }

    const playable = tracks.filter((_, position) => !unavailable(position));
    const before = tracks.slice(0, index).filter((_, position) => !unavailable(position));

    void play(playable, { index: before.length });
  };
};

/**
 * A list of songs with the Paper track row states: default, hover (play glyph and actions),
 * playing (accent bars and semibold title), plus like and the row menu everywhere.
 */
export function TrackList({
  tracks,
  variant,
  menuExtra,
  label,
  header = true,
  unavailable,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly variant: TrackListVariant;
  readonly menuExtra?: (track: Track, index: number) => ReactNode;
  readonly label: string;
  readonly header?: boolean;
  /**
   * Whether the song at an index can't play because its file is gone. Such rows are greyed out,
   * can't be played, and keep their menu so they can be removed.
   */
  readonly unavailable?: (index: number) => boolean;
}) {
  const player = usePlayer();
  const play = useRowPlay(tracks, unavailable);
  const currentId = player.track?.id ?? null;
  const playing = player.status === "playing" || player.status === "buffering";

  return (
    <div role="table" aria-label={label} className="flex flex-col">
      <div
        role="row"
        className={cn(
          "hidden h-8 shrink-0 items-center gap-3 border-b border-border px-2",
          header && "lg:flex",
        )}
      >
        {variant === "album" ? (
          <>
            <span role="columnheader" className={cn(headerCell, "w-7 shrink-0 text-right")}>
              #
            </span>
            <span role="columnheader" className={cn(headerCell, "grow")}>
              TITLE
            </span>
          </>
        ) : (
          <>
            <span aria-hidden className="w-row shrink-0" />
            <span role="columnheader" className={cn(headerCell, "grow-2 basis-0")}>
              TITLE
            </span>
            <span role="columnheader" className={cn(headerCell, "grow-[1.4] basis-0")}>
              ALBUM
            </span>
            <span role="columnheader" className={cn(headerCell, "w-[110px] shrink-0")}>
              FORMAT
            </span>
          </>
        )}
        <span aria-hidden className="w-9 shrink-0" />
        <span role="columnheader" className={cn(headerCell, "w-row-touch shrink-0 text-right")}>
          TIME
        </span>
        <span aria-hidden className="w-9 shrink-0" />
      </div>
      {tracks.map((track, index) => (
        <TrackRow
          key={`${index}-${track.id}`}
          track={track}
          index={index}
          variant={variant}
          current={track.id === currentId}
          playing={track.id === currentId && playing}
          available={unavailable?.(index) !== true}
          onPlay={() => play(index)}
          menuExtra={menuExtra?.(track, index)}
        />
      ))}
    </div>
  );
}

function TrackRow({
  track,
  index,
  variant,
  current,
  playing,
  available,
  onPlay,
  menuExtra,
}: {
  readonly track: Track;
  readonly index: number;
  readonly variant: TrackListVariant;
  readonly current: boolean;
  readonly playing: boolean;
  readonly available: boolean;
  readonly onPlay: () => void;
  readonly menuExtra: ReactNode;
}) {
  const number = track.trackNumber ?? index + 1;

  if (!available) {
    return <UnavailableRow track={track} number={number} variant={variant} menuExtra={menuExtra} />;
  }

  const playButton = (
    <button
      type="button"
      aria-label={`Play ${track.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onPlay();
      }}
      // Transparent until hovered or focused, never display:none, so keyboards and screen readers
      // reach it.
      className="absolute inset-0 flex items-center justify-center rounded-[4px] outline-none pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <PlayIcon className="size-3.5 text-text" fill="currentColor" strokeWidth={0} />
    </button>
  );

  return (
    <div
      role="row"
      aria-current={current ? "true" : undefined}
      onDoubleClick={onPlay}
      className={rowClassName(variant)}
    >
      {/* Phones tap anywhere on the row to play. */}
      <button
        type="button"
        aria-label={`Play ${track.title}`}
        onClick={onPlay}
        className="absolute inset-0 lg:hidden"
      />
      {variant === "album" ? (
        <span
          role="cell"
          className={cn(numberCell, "relative flex h-full items-center lg:justify-end")}
        >
          {playing ? (
            <PlayingBars />
          ) : (
            <span
              className={cn(
                "font-sans text-md/base text-text-muted lg:font-mono lg:text-sm/xs lg:group-hover/row:invisible lg:group-has-[:focus-visible]/row:invisible",
                current && "text-accent lg:text-text-muted",
              )}
            >
              {number}
            </span>
          )}
          {playing ? null : <span className="hidden lg:contents">{playButton}</span>}
        </span>
      ) : (
        <span role="cell" className="relative shrink-0">
          <Artwork url={track.artUrl} seed={track.albumId} className={coverClassName}>
            {playing ? (
              <span className="absolute inset-0 flex items-end justify-center bg-black/35 pb-2.5">
                <PlayingBars />
              </span>
            ) : (
              <span className="hidden lg:contents">{playButton}</span>
            )}
          </Artwork>
        </span>
      )}

      <span
        role="cell"
        className={cn(
          "flex min-w-0 flex-col gap-px",
          variant === "album" ? "grow" : "grow lg:grow-2 lg:basis-0",
        )}
      >
        <span
          className={cn(
            "truncate font-sans text-text",
            variant === "album" ? "text-md/base lg:text-base/sm" : "text-md/base lg:text-base/sm",
            current && "font-semibold max-lg:text-accent max-lg:font-medium",
          )}
        >
          {track.title}
        </span>
        {variant === "list" ? (
          <span className="truncate font-sans text-sm/xs text-text-muted">{track.artist}</span>
        ) : null}
      </span>

      {variant === "list" ? (
        <>
          <span role="cell" className="hidden min-w-0 grow-[1.4] basis-0 lg:block">
            <Link
              to="/albums/$albumId"
              params={{ albumId: track.albumId }}
              className="relative truncate font-sans text-sm/xs text-text-muted hover:text-text hover:underline"
            >
              {track.album}
            </Link>
          </span>
          <span role="cell" className={formatCell}>
            {formatQuality(track)}
          </span>
        </>
      ) : null}

      <span role="cell" className="relative hidden w-9 shrink-0 justify-center lg:flex">
        <LikeButton
          track={track}
          className={cn(
            "size-9 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
            track.liked && "opacity-100",
          )}
          iconClassName="size-[18px]"
        />
      </span>
      <span
        role="cell"
        className="hidden w-row-touch shrink-0 text-right font-mono text-sm/xs text-text-muted lg:block"
      >
        {formatDuration(track.durationMs)}
      </span>
      <span role="cell" className="relative flex w-12 shrink-0 justify-center lg:w-9">
        <TrackMenu
          track={track}
          extra={menuExtra}
          className="lg:opacity-0 lg:group-hover/row:opacity-100 lg:focus-visible:opacity-100 lg:data-popup-open:opacity-100"
          trigger={<MoreHorizontalIcon className="size-5" />}
        />
      </span>
    </div>
  );
}

/**
 * A song whose file is gone from disk, greyed out like Spotify's unavailable songs: it can't play,
 * and its menu keeps the actions that still work, such as removing it from the playlist.
 */
function UnavailableRow({
  track,
  number,
  variant,
  menuExtra,
}: {
  readonly track: Track;
  readonly number: number;
  readonly variant: TrackListVariant;
  readonly menuExtra: ReactNode;
}) {
  return (
    <div role="row" className={cn(rowClassName(variant), "gap-3")}>
      <span role="cell" className="flex min-w-0 grow items-center gap-3 opacity-(--opacity-muted)">
        {variant === "album" ? (
          <span
            aria-hidden
            className={cn(
              numberCell,
              "font-sans text-md/base text-text-muted lg:text-right lg:font-mono lg:text-sm/xs",
            )}
          >
            {number}
          </span>
        ) : (
          <Artwork
            url={track.artUrl}
            seed={track.albumId}
            className={cn(coverClassName, "shrink-0 grayscale")}
          />
        )}
        <span className="flex min-w-0 grow flex-col gap-px lg:grow-2 lg:basis-0">
          <span className="truncate font-sans text-md/base text-text lg:text-base/sm">
            {track.title}
          </span>
          <span className="truncate font-sans text-sm/xs text-text-muted">
            Unavailable · {track.artist}
          </span>
        </span>
        {variant === "list" ? (
          <>
            <span className="hidden min-w-0 grow-[1.4] basis-0 truncate font-sans text-sm/xs text-text-muted lg:block">
              {track.album}
            </span>
            <span className={formatCell}>{formatQuality(track)}</span>
          </>
        ) : null}
        <span aria-hidden className="hidden w-9 shrink-0 lg:block" />
        <span className="hidden w-row-touch shrink-0 text-right font-mono text-sm/xs text-text-muted lg:block">
          {formatDuration(track.durationMs)}
        </span>
      </span>
      <span role="cell" className="relative flex w-12 shrink-0 justify-center lg:w-9">
        <TrackMenu
          track={track}
          playable={false}
          extra={menuExtra}
          className="lg:opacity-0 lg:group-hover/row:opacity-100 lg:focus-visible:opacity-100 lg:data-popup-open:opacity-100"
          trigger={<MoreHorizontalIcon className="size-5" />}
        />
      </span>
    </div>
  );
}

/** Skeleton rows matching the track list while songs load. */
export function TrackListSkeleton({ rows = 8 }: { readonly rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-row items-center gap-3 px-2">
          <span className="flex w-7 shrink-0 justify-end">
            <Skeleton className="h-2.5 w-3" />
          </span>
          <span className="grow-2 basis-0">
            <Skeleton className="h-2.5 w-[180px] max-w-full" />
          </span>
          <span className="hidden grow-[1.4] basis-0 lg:block">
            <Skeleton className="h-2.5 w-[110px]" />
          </span>
          <span className="flex w-row-touch shrink-0 justify-end">
            <Skeleton className="h-2.5 w-8" />
          </span>
          <span className="w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}
