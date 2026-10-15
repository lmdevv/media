import type { TrackId } from "@music/commands/ids";
import type { Track } from "@music/commands/models";
import { useCurrentTrack } from "@music/player/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlayIcon } from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { TrackMenu } from "@/components/playlists/track-menu";
import { formatDuration, formatQuality } from "@/lib/format";

import { Artwork, PlayingBars } from "./artwork";
import { usePlayTracks } from "./cards";
import { LikeButton } from "./like-button";
import { dropLine } from "@/lib/reorder";
import type { DropSide } from "@/lib/reorder";
import { useIsDesktop } from "@/lib/use-media";
import { useWindowed } from "@/lib/use-windowed";

import { MoveButtons, ReorderHandle } from "./reorder";
import type { Reorder } from "./reorder";

/** Reordering for a list whose rows can move: drag (desktop) or up/down buttons (phone mode). */
export interface ListReorder {
  readonly reorder: Reorder;
  readonly mode: "drag" | "buttons";
}

/**
 * `album` is the numbered Apple-style list (album detail); `list` is the songs table with covers,
 * album, and format columns (Songs, playlists, Liked songs).
 */
export type TrackListVariant = "album" | "list";

const headerCell = "font-mono text-xs/xs tracking-mono text-text-muted";

/**
 * A row's height. The rows and the probe that measures a row's height for windowing share it, so
 * the estimate for rows not yet on the page follows the stylesheet.
 */
const rowHeightClassName = (variant: TrackListVariant): string =>
  variant === "album" ? "h-12 lg:h-row" : "h-12 lg:h-13";

/** The row box both playable and unavailable songs use, so the two stay the same size. */
const rowClassName = (variant: TrackListVariant): string =>
  cn(
    "group/row relative flex shrink-0 items-center rounded-sm select-none",
    rowHeightClassName(variant),
    "border-t-hairline border-border pr-1 lg:gap-3 lg:border-t-0 lg:px-2",
    variant === "album" ? undefined : "gap-3",
    "hover:bg-surface has-[[data-popup-open]]:bg-surface",
  );

/** The rows' reorder controls: the same object while the list's mode is, so rows stay memoized. */
interface RowReorder {
  readonly mode: ListReorder["mode"];
  readonly rowProps: Reorder["rowProps"];
  readonly moveBy: Reorder["moveBy"];
}

/** The playing song, and whether it plays, as a block's rows see it. */
interface NowPlaying {
  readonly trackId: TrackId | null;
  readonly playing: boolean;
}

/** Renders the row for the song at `index`. */
type RenderRow = (track: Track, index: number, now: NowPlaying) => ReactNode;

/** How many songs the list holds, for the reorder controls' "Position 3 of 40". */
const ListLengthContext = createContext(0);

/** The track number column of the album variant. */
const numberCell = "w-7.5 shrink-0 lg:w-7";

/** A song's cover in the list variant. */
const coverClassName = "size-11 rounded-xs lg:size-row";

/** The format column of the list variant. */
const formatCell = "hidden w-27.5 shrink-0 font-mono text-xs/xs text-text-muted lg:block";

/**
 * Plays a song from a list on double click (desktop) or tap (phone), queueing the list's songs
 * that can play. Stable while the list is, so unchanged rows skip re-rendering.
 */
const useRowPlay = (
  tracks: ReadonlyArray<Track>,
  unavailable: ((index: number) => string | null) | undefined,
) => {
  const play = usePlayTracks();

  return useCallback(
    (index: number) => {
      if (unavailable === undefined) {
        void play(tracks, { index });

        return;
      }

      const playable = tracks.filter((_, position) => unavailable(position) === null);

      const before = tracks.slice(0, index).filter((_, position) => unavailable(position) === null);

      void play(playable, { index: before.length });
    },
    [play, tracks, unavailable],
  );
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
  withheld,
  byline,
  highlight,
  reorder,
  windowing = "long",
  rowKey,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly variant: TrackListVariant;
  readonly menuExtra?: (track: Track, index: number) => ReactNode;
  readonly label: string;
  readonly header?: boolean;
  /**
   * Why the song at an index can't play ("Unavailable" when its file is gone, "No access" when it
   * is in a library you can't listen to), or null when it can. Such rows are greyed out, can't be
   * played, and keep their menu so they can be removed.
   */
  readonly unavailable?: (index: number) => string | null;
  /**
   * Whether the row at an index stands in for a song you may not know anything about: its menu
   * keeps only `menuExtra`.
   */
  readonly withheld?: (index: number) => boolean;
  /** More to say under a row's artist, such as who added it to a shared playlist. */
  readonly byline?: ((index: number) => string | null) | undefined;
  /** A song to highlight and scroll to, from a shared song link. */
  readonly highlight?: TrackId | null;
  /** Lets rows be moved; the list's order then comes back from the server. */
  readonly reorder?: ListReorder | undefined;
  /**
   * `long` windows lists longer than one block of rows; `always` also windows a single block, for
   * callers that list one page of a longer list per `TrackList` (Songs).
   */
  readonly windowing?: "long" | "always";
  /**
   * A stable key for the row at an index, such as a playlist entry's ID, so moving or adding an
   * entry doesn't remount the rows around it. Without it rows are keyed by place and song.
   */
  readonly rowKey?: ((index: number) => string) | undefined;
}) {
  const play = useRowPlay(tracks, unavailable);
  const table = useRef<HTMLDivElement>(null);

  const highlightIndex =
    highlight === undefined || highlight === null
      ? -1
      : tracks.findIndex((track) => track.id === highlight);

  const mode = reorder?.mode;
  const rowProps = reorder?.reorder.rowProps;
  const moveBy = reorder?.reorder.moveBy;

  const controls = useMemo(
    (): RowReorder | undefined =>
      mode === undefined || rowProps === undefined || moveBy === undefined
        ? undefined
        : { mode, rowProps, moveBy },
    [mode, rowProps, moveBy],
  );

  // The row a drag started from stays on the page, so its drag can end.
  const dragging = reorder?.reorder.dragging ?? null;
  const [probe, setProbe] = useState<HTMLElement | null>(null);
  const rowHeight = useRowHeight(probe);
  const scrolledTo = useRef<TrackId | null>(null);

  // A shared song link opens the list scrolled to the song: once per song, after the row height is
  // read and a frame later, so the empty blocks above have their heights. Found by its index (its
  // block is pinned), so an unavailable row counts too, and tried again when the songs arrive.
  useEffect(() => {
    if (highlight === undefined || highlight === null || highlightIndex === -1) return undefined;

    if (rowHeight === null || scrolledTo.current === highlight) return undefined;

    const frame = requestAnimationFrame(() => {
      const block = table.current?.querySelectorAll(":scope > [role=rowgroup]")[
        Math.floor(highlightIndex / BLOCK_ROWS)
      ];

      const row = block?.children[highlightIndex % BLOCK_ROWS];

      if (row === undefined) return;
      row.scrollIntoView({ block: "center" });
      scrolledTo.current = highlight;
    });

    return () => cancelAnimationFrame(frame);
  }, [highlight, highlightIndex, rowHeight]);

  const renderRow = (track: Track, index: number, now: NowPlaying) => (
    <TrackRow
      key={rowKey?.(index) ?? `${index}-${track.id}`}
      track={track}
      index={index}
      variant={variant}
      current={track.id === now.trackId}
      playing={track.id === now.trackId && now.playing}
      unavailable={unavailable?.(index) ?? null}
      withheld={withheld?.(index) ?? false}
      byline={byline?.(index) ?? null}
      highlighted={highlight === track.id}
      reorder={controls}
      dropSide={reorder?.mode === "drag" ? reorder.reorder.dropSide(index) : null}
      onPlay={play}
      menuExtra={menuExtra}
    />
  );

  return (
    <div ref={table} role="table" aria-label={label} className="relative flex flex-col">
      <div
        ref={setProbe}
        aria-hidden
        className={cn(rowHeightClassName(variant), "pointer-events-none invisible absolute")}
      />
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
            <span role="columnheader" className={cn(headerCell, "w-27.5 shrink-0")}>
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
      <ListLengthContext value={tracks.length}>
        <WindowedRows
          tracks={tracks}
          renderRow={renderRow}
          pinned={[highlightIndex, dragging ?? -1]}
          pinOneBlock={windowing === "long"}
          rowHeight={rowHeight}
        />
      </ListLengthContext>
    </div>
  );
}

/** Rows per block of a long list; blocks far from view keep only their height. */
const BLOCK_ROWS = 100;

/**
 * The rows of a list in blocks of {@link BLOCK_ROWS}, rendered only near the visible part of the
 * list, so a 1,000-song playlist mounts a few hundred rows instead of all of them. The first block
 * renders at once, and so do the blocks holding a `pinned` row (a row to scroll to, or the row being
 * dragged). A list of one block always renders unless `pinOneBlock` is off. Short lists use the
 * same blocks, so a list growing past one block keeps its rows (and their menus and focus).
 */
function WindowedRows({
  tracks,
  renderRow,
  pinned,
  pinOneBlock,
  rowHeight,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly renderRow: RenderRow;
  /** Row indexes whose blocks always render; -1 for none. */
  readonly pinned: ReadonlyArray<number>;
  readonly pinOneBlock: boolean;
  /** One row's height, from the probe; null before it has been read. */
  readonly rowHeight: number | null;
}) {
  const starts = Array.from(
    { length: Math.ceil(tracks.length / BLOCK_ROWS) },
    (_, block) => block * BLOCK_ROWS,
  );

  return starts.map((start) => (
    <RowBlock
      key={start}
      tracks={tracks}
      start={start}
      renderRow={renderRow}
      first={start === 0}
      pinned={
        (pinOneBlock && tracks.length <= BLOCK_ROWS) ||
        pinned.some((index) => index >= start && index < start + BLOCK_ROWS)
      }
      rowHeight={rowHeight}
    />
  ));
}

/**
 * The height of `probe`, an empty element with a row's height classes: read before the first paint
 * and again whenever it changes (the layout crossing the desktop breakpoint), so it is always a real
 * row's height and never a measurement of an empty block.
 */
const useRowHeight = (probe: HTMLElement | null): number | null => {
  const [height, setHeight] = useState<number | null>(null);
  // Read again in the same commit that crosses the breakpoint, before paint: the probe's resize
  // observer reports a frame later, when blocks would already have used the old height.
  const desktop = useIsDesktop();

  useLayoutEffect(() => {
    if (probe === null) return undefined;

    const read = (size: number) => {
      if (size > 0) setHeight(size);
    };

    read(probe.getBoundingClientRect().height);

    const observer = new ResizeObserver((entries) => {
      const size = entries.at(-1)?.borderBoxSize[0]?.blockSize;

      if (size !== undefined) read(size);
    });

    observer.observe(probe);

    return () => observer.disconnect();
  }, [probe, desktop]);

  return height;
};

function RowBlock({
  tracks,
  start,
  renderRow,
  first,
  pinned,
  rowHeight,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly start: number;
  readonly renderRow: RenderRow;
  readonly first: boolean;
  readonly pinned: boolean;
  readonly rowHeight: number | null;
}) {
  const count = Math.min(BLOCK_ROWS, tracks.length - start);

  const windowed = useWindowed({
    initiallyNear: first,
    pinned,
    estimate: rowHeight === null ? null : rowHeight * count,
    size: count,
  });

  return (
    <div
      ref={windowed.ref}
      role="rowgroup"
      // Before the row height is read (the same frame, before paint) an empty block is flat.
      style={windowed.shown ? undefined : { height: windowed.height ?? 0 }}
    >
      {windowed.shown ? (
        <ShownRows tracks={tracks} start={start} count={count} renderRow={renderRow} />
      ) : null}
    </div>
  );
}

/**
 * The rows of a block on the page. Only these follow the playing song, so a list's empty blocks (and
 * a Songs page far from view) don't re-render on play, pause, or a new song.
 */
function ShownRows({
  tracks,
  start,
  count,
  renderRow,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly start: number;
  readonly count: number;
  readonly renderRow: RenderRow;
}) {
  // Only the current song and status: a position report or queue change re-renders no rows.
  const { trackId, status } = useCurrentTrack();
  const now = { trackId, playing: status === "playing" || status === "buffering" };

  return tracks
    .slice(start, start + count)
    .map((track, offset) => renderRow(track, start + offset, now));
}

/** The drag handle (desktop) or up/down buttons (phone reorder mode) of a movable row. */
function RowMover({
  reorder,
  label,
  index,
  place,
}: {
  readonly reorder: RowReorder | undefined;
  readonly label: string;
  readonly index: number;
  /** The handle sits before the row; the buttons go before the row's menu. */
  readonly place: "start" | "end";
}) {
  // Read here, not passed to the rows, so a song added or removed re-renders only the movers.
  const count = useContext(ListLengthContext);

  if (reorder === undefined) return null;

  if (reorder.mode === "drag" && place === "start") {
    return (
      <span role="cell" className="relative hidden shrink-0 lg:flex">
        <ReorderHandle
          label={label}
          index={index}
          count={count}
          reorder={reorder}
          className="-mx-1 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        />
      </span>
    );
  }

  if (reorder.mode === "buttons" && place === "end") {
    return (
      <span role="cell" className="relative flex shrink-0">
        <MoveButtons label={label} index={index} count={count} reorder={reorder} />
      </span>
    );
  }

  return null;
}

/** Drag props and the drop line for a movable row. */
const movable = (reorder: RowReorder | undefined, index: number, dropSide: DropSide | null) =>
  reorder?.mode === "drag"
    ? { props: reorder.rowProps(index), line: dropLine(dropSide) }
    : { props: {}, line: null };

/**
 * One song row. Memoized: a block's shown rows re-render when the current song changes, and only
 * the rows whose props changed (the old and new current song) render again.
 */
const TrackRow = memo(function TrackRow({
  track,
  index,
  variant,
  current,
  playing,
  unavailable,
  withheld,
  byline,
  highlighted,
  reorder,
  dropSide,
  onPlay,
  menuExtra,
}: {
  readonly track: Track;
  readonly index: number;
  readonly variant: TrackListVariant;
  readonly current: boolean;
  readonly playing: boolean;
  readonly unavailable: string | null;
  readonly withheld: boolean;
  readonly byline: string | null;
  readonly highlighted: boolean;
  readonly reorder: RowReorder | undefined;
  /** Where a dragged row would land relative to this one, for its drop line. */
  readonly dropSide: DropSide | null;
  /** Plays the list from the row at `index`. */
  readonly onPlay: (index: number) => void;
  /** Builds the row menu's extra items; called here so a stable function keeps the row memoized. */
  readonly menuExtra: ((track: Track, index: number) => ReactNode) | undefined;
}) {
  const number = track.trackNumber ?? index + 1;
  const extra = menuExtra?.(track, index);
  const playRow = () => onPlay(index);
  const move = movable(reorder, index, dropSide);

  if (unavailable !== null) {
    return (
      <UnavailableRow
        track={track}
        number={number}
        variant={variant}
        reason={unavailable}
        withheld={withheld}
        byline={byline}
        menuExtra={extra}
        mover={{ reorder, index, dropSide }}
      />
    );
  }

  const playButton = (
    <button
      type="button"
      aria-label={`Play ${track.title}`}
      onClick={(event) => {
        event.stopPropagation();
        playRow();
      }}
      // Transparent until hovered or focused, never display:none, so keyboards and screen readers
      // reach it.
      className="absolute inset-0 flex items-center justify-center rounded-xs outline-none pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <PlayIcon className="size-3.5 text-text" fill="currentColor" strokeWidth={0} />
    </button>
  );

  return (
    <div
      role="row"
      aria-current={current ? "true" : undefined}
      data-highlighted={highlighted ? "" : undefined}
      onDoubleClick={playRow}
      {...move.props}
      className={cn(
        rowClassName(variant),
        highlighted && "bg-surface ring-2 ring-accent/40",
        move.line,
      )}
    >
      <RowMover reorder={reorder} label={track.title} index={index} place="start" />
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
              <span className="absolute inset-0 flex items-end justify-center bg-dark-canvas/35 pb-2.5">
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
        {/* Phones tap anywhere on the row to play. The cell isn't positioned, so the button covers
            the row while staying inside a cell, as the table role requires. */}
        <button
          type="button"
          aria-label={`Play ${track.title}`}
          onClick={playRow}
          className="absolute inset-0 lg:hidden"
        />
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
          <span className="truncate font-sans text-sm/xs text-text-muted">
            {byline === null ? track.artist : `${track.artist} · ${byline}`}
          </span>
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
          iconClassName="size-4.5"
        />
      </span>
      <span
        role="cell"
        className="hidden w-row-touch shrink-0 text-right font-mono text-sm/xs text-text-muted lg:block"
      >
        {formatDuration(track.durationMs)}
      </span>
      <RowMover reorder={reorder} label={track.title} index={index} place="end" />
      <span role="cell" className="relative flex w-12 shrink-0 justify-center lg:w-9">
        <TrackMenu
          track={track}
          extra={extra}
          className="lg:opacity-0 lg:group-hover/row:opacity-100 lg:focus-visible:opacity-100 lg:data-popup-open:opacity-100"
          trigger={<MoreHorizontalIcon className="size-5" />}
        />
      </span>
    </div>
  );
});

/**
 * A song that can't play here, greyed out like Spotify's unavailable songs: its file is gone, or
 * it is in a library you can't listen to. Its menu keeps the actions that still work, such as
 * removing it from the playlist.
 */
function UnavailableRow({
  track,
  number,
  variant,
  reason,
  withheld,
  byline,
  menuExtra,
  mover,
}: {
  readonly track: Track;
  readonly number: number;
  readonly variant: TrackListVariant;
  readonly reason: string;
  readonly withheld: boolean;
  readonly byline: string | null;
  readonly menuExtra: ReactNode;
  readonly mover: {
    readonly reorder: RowReorder | undefined;
    readonly index: number;
    readonly dropSide: DropSide | null;
  };
}) {
  const move = movable(mover.reorder, mover.index, mover.dropSide);

  return (
    <div role="row" {...move.props} className={cn(rowClassName(variant), "gap-3", move.line)}>
      <RowMover reorder={mover.reorder} index={mover.index} label={track.title} place="start" />
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
            {[reason, track.artist, byline].filter((part) => part !== null).join(" · ")}
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
      <RowMover reorder={mover.reorder} index={mover.index} label={track.title} place="end" />
      <span role="cell" className="relative flex w-12 shrink-0 justify-center lg:w-9">
        <TrackMenu
          track={track}
          playable={false}
          withheld={withheld}
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
            <Skeleton className="h-2.5 w-45 max-w-full" />
          </span>
          <span className="hidden grow-[1.4] basis-0 lg:block">
            <Skeleton className="h-2.5 w-27.5" />
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
