import type { AlbumId, ArtistId } from "@music/commands/ids";
import type { AlbumCard as Album, ArtistCard as Artist, Track } from "@music/commands/models";
import { useLatestPlayer } from "@music/player/react";
import { useReadOnce } from "@music/sdk/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { ChevronRightIcon, PlayIcon } from "lucide-react";
import { memo, useCallback } from "react";
import type { ReactNode } from "react";

import { toastFailure } from "@/lib/action";

import { Artwork, PlayingBars } from "./artwork";

/**
 * Starts a list of songs, optionally shuffled, reporting failures as toasts. The function is
 * stable and reads the player when it runs, so a list of cards or rows that can play doesn't
 * re-render on every player change.
 */
export const usePlayTracks = (): ((
  tracks: ReadonlyArray<Pick<Track, "id">>,
  options?: { readonly index?: number; readonly shuffle?: boolean },
) => Promise<void>) => {
  const latestPlayer = useLatestPlayer();

  return useCallback(
    async (tracks, options = {}) => {
      if (tracks.length === 0) return;

      const player = latestPlayer();

      try {
        if (options.shuffle !== undefined && options.shuffle !== player.shuffle) {
          await player.setShuffle(options.shuffle);
        }

        const ids = tracks.map((track) => track.id);

        const index =
          options.shuffle === true ? Math.floor(Math.random() * ids.length) : options.index;

        await player.playTracks(ids, index);
      } catch (cause) {
        toastFailure(cause);
      }
    },
    [latestPlayer],
  );
};

/** Loads an album and plays it from the top (or shuffled). Stable, like `usePlayTracks`. */
export const usePlayAlbum = (): ((albumId: AlbumId, shuffle?: boolean) => Promise<void>) => {
  const readAlbum = useReadOnce("albums.get");
  const play = usePlayTracks();

  return useCallback(
    async (albumId, shuffle = false) => {
      try {
        const album = await readAlbum({ albumId });
        await play(album.tracks, { shuffle });
      } catch (cause) {
        toastFailure(cause);
      }
    },
    [readAlbum, play],
  );
};

/** Loads an artist and plays their top songs. Stable, like `usePlayTracks`. */
export const usePlayArtist = (): ((artistId: ArtistId, shuffle?: boolean) => Promise<void>) => {
  const readArtist = useReadOnce("artists.get");
  const play = usePlayTracks();

  return useCallback(
    async (artistId, shuffle = false) => {
      try {
        const artist = await readArtist({ artistId });
        await play(artist.topTracks, { shuffle });
      } catch (cause) {
        toastFailure(cause);
      }
    },
    [readArtist, play],
  );
};

/**
 * The heavy screen title with a mono eyebrow, from the Paper desktop headers.
 *
 * @param eyebrow - The line above the title; `null` while it loads, which keeps its line so the
 *   page doesn't move down when it arrives.
 */
export function PageHeader({
  eyebrow,
  title,
  actions,
  className,
}: {
  readonly eyebrow?: string | null | undefined;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow === undefined ? null : (
          <span
            aria-hidden={eyebrow === null ? true : undefined}
            className="font-mono text-xs/xs tracking-mono text-text-muted uppercase"
          >
            {eyebrow ?? "\u00a0"}
          </span>
        )}
        <h1 className="font-sans text-phone-large-title leading-10.25 font-heavy tracking-tighter text-text lg:text-2xl/2xl lg:tracking-display">
          {title}
        </h1>
      </div>
      {actions}
    </header>
  );
}

/** A section title with an optional "See all" link. Phones show the iOS chevron instead. */
export function SectionHeader({
  title,
  to,
  className,
}: {
  readonly title: string;
  readonly to?: LinkProps["to"];
  readonly className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", className)}>
      {to === undefined ? (
        <h2 className="font-sans text-phone-title leading-lg font-bold tracking-snug text-text lg:text-lg/lg lg:font-semibold lg:tracking-tight">
          {title}
        </h2>
      ) : (
        <Link to={to} className="group flex items-center gap-1 lg:pointer-events-none">
          <h2 className="font-sans text-phone-title leading-lg font-bold tracking-snug text-text lg:text-lg/lg lg:font-semibold lg:tracking-tight">
            {title}
          </h2>
          <ChevronRightIcon
            aria-hidden
            className="size-4.5 text-text-muted lg:hidden"
            strokeWidth={2.5}
          />
        </Link>
      )}
      {to === undefined ? null : (
        <Link
          to={to}
          className="hidden font-sans text-sm/xs font-medium text-text-muted hover:text-text lg:block"
        >
          See all
        </Link>
      )}
    </div>
  );
}

/**
 * An album cover with title and subtitle; hovering shows a play button on the cover. Memoized:
 * a grid of albums re-renders often as its pages load.
 */
export const AlbumCard = memo(function AlbumCard({
  album,
  subtitle,
  className,
}: {
  readonly album: Album;
  readonly subtitle?: string;
  readonly className?: string;
}) {
  const playAlbum = usePlayAlbum();

  return (
    <div className={cn("group/card relative flex min-w-0 flex-col gap-2.5", className)}>
      <Artwork url={album.artUrl} seed={album.id} className="aspect-square w-full rounded-md">
        <button
          type="button"
          aria-label={`Play ${album.title}`}
          onClick={() => void playAlbum(album.id)}
          className="absolute right-2.5 bottom-2.5 z-10 flex size-row items-center justify-center rounded-full bg-text text-text-inverse opacity-0 shadow-md transition-opacity outline-none group-hover/card:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <PlayIcon className="size-4 translate-x-px" fill="currentColor" strokeWidth={0} />
        </button>
      </Artwork>
      <Link
        to="/albums/$albumId"
        params={{ albumId: album.id }}
        className="flex min-w-0 flex-col gap-0.5 outline-none after:absolute after:inset-0 focus-visible:underline"
      >
        <span className="truncate font-sans text-base/sm font-medium text-text">{album.title}</span>
        <span className="truncate font-sans text-sm/xs text-text-muted">
          {subtitle ?? album.artist}
        </span>
      </Link>
    </div>
  );
});

/** A round artist image with the name under it. Memoized, like `AlbumCard`. */
export const ArtistCircle = memo(function ArtistCircle({
  artist,
  className,
}: {
  readonly artist: Pick<Artist, "id" | "name" | "artUrl">;
  readonly className?: string;
}) {
  return (
    <Link
      to="/artists/$artistId"
      params={{ artistId: artist.id }}
      className={cn(
        "flex min-w-0 flex-col items-center gap-2.5 outline-none focus-visible:underline",
        className,
      )}
    >
      <Artwork url={artist.artUrl} seed={artist.id} round className="aspect-square w-full" />
      <span className="max-w-full truncate font-sans text-base/sm font-medium text-text">
        {artist.name}
      </span>
    </Link>
  );
});

/** A 56px Home shortcut tile with the cover on the left; marks the album that is playing. */
export function QuickTile({
  title,
  artUrl,
  seed,
  to,
  playing,
}: {
  readonly title: string;
  readonly artUrl: string | null;
  readonly seed: string;
  readonly to: ReactNode;
  readonly playing: boolean;
}) {
  return (
    <div className="relative flex h-row-touch min-w-0 items-center gap-3.5 overflow-hidden rounded-sm bg-surface hover:bg-border/70 dark:hover:bg-surface-raised">
      <Artwork url={artUrl} seed={seed} className="size-row-touch rounded-none" />
      <span className="grow truncate font-sans text-base/sm font-semibold text-text">{title}</span>
      {playing ? <PlayingBars className="mr-4" /> : null}
      {to}
    </div>
  );
}

/** Six skeleton album cards for a loading grid row. */
export function AlbumRowSkeleton({
  count = 6,
  title = true,
}: {
  readonly count?: number;
  readonly title?: boolean;
}) {
  const widths = ["70%", "60%", "75%", "55%", "65%", "70%"];

  return (
    <div className="flex flex-col gap-4">
      {title ? <Skeleton className="h-3.5 w-45 rounded-xs" /> : null}
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="flex flex-col gap-2.5">
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="h-2.5" style={{ width: widths[index % widths.length] }} />
            <Skeleton className="h-2.5 w-[45%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
