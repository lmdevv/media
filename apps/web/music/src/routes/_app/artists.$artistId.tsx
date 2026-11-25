import { usePlayer } from "@media/player/react";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { creditsOf } from "@media/contracts/artist-credits";
import { preloadFirstPage, usePages } from "@media/ui/lib/pages";
import type { PageOpts } from "@media/ui/lib/pages";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { ArtistCredits } from "@/components/library/artist-credits";
import { Artwork, PlayingBars } from "@/components/library/artwork";
import { AlbumCard, SectionHeader, usePlayTracks } from "@/components/library/cards";
import { LikeButton } from "@/components/library/like-button";
import { ListTail } from "@/components/library/paged";
import { CollectionMenu } from "@/components/playlists/collection-menu";
import { TrackMenu } from "@/components/playlists/track-menu";
import { DetailError } from "@/components/route-error";
import type { MissingCopy } from "@/components/route-error";
import { placeholderColors } from "@/lib/art";
import { artSrc } from "@/lib/art-src";
import { formatDuration, plural } from "@/lib/format";
import { asArtistId } from "@/lib/models";
import type { ArtistId, Track } from "@/lib/models";
import { PAGE_ROWS, preloadAllRows, useAllRows } from "@/lib/pages";
import { useMusic, useRead } from "@/lib/platform";
import { useIsDesktop } from "@/lib/use-media";

const MISSING: MissingCopy = {
  title: "This artist isn't in your library anymore",
  description:
    "A rescan may have removed their songs, their folder was removed from Lar Music, they're in a library that isn't shared with you, or the link is wrong.",
  back: { to: "/artists", label: "Back to artists" },
};

/**
 * The arguments of each page of an artist's albums, or of the songs crediting them, shared by the
 * loader and the page.
 */
const pagesOf = (artistId: ArtistId) => (paginationOpts: PageOpts) => ({
  artistId,
  paginationOpts,
});

export const Route = createFileRoute("/_app/artists/$artistId")({
  params: {
    parse: (params) => ({ artistId: asArtistId(params.artistId) }),
    stringify: (params) => ({ artistId: params.artistId }),
  },
  loader: async ({ context: { platform }, params: { artistId } }) => {
    // The songs list opens on the top songs, which the artist read brings, until its pages arrive.
    void preloadFirstPage(platform.music.artists.tracks, pagesOf(artistId), PAGE_ROWS);
    await Promise.all([
      platform.music.artists.get.preload({ artistId }),
      preloadAllRows(platform.music.artists.albums, pagesOf(artistId)),
    ]);
  },
  pendingComponent: ArtistSkeleton,
  component: ArtistPage,
  errorComponent: ArtistError,
});

/** The top songs an artist page shows, as the core caps them, and the songs it lists at first. */
const TOP_SONGS = 10;

function ArtistSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-8 pb-12">
      <Skeleton className="h-65 w-full shrink-0 rounded-none lg:h-75" />
      <div className="flex flex-col gap-12 px-5 lg:flex-row lg:px-12">
        <div className="flex w-full shrink-0 flex-col gap-3.5 lg:w-sidebar">
          <SkeletonLine className="font-sans text-lg/lg" bar="h-4 w-36" />
          <Skeleton className="aspect-square w-full max-w-sidebar rounded-md" />
          <div className="flex flex-col gap-0.5">
            <SkeletonLine className="font-sans text-base/sm" bar="h-2.5 w-32" />
            <SkeletonLine className="font-sans text-sm/xs" bar="h-2.5 w-20" />
          </div>
        </div>
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <SkeletonLine className="pb-2 font-sans text-lg/lg" bar="h-4 w-28" />
          {Array.from({ length: TOP_SONGS }, (_, index) => (
            <div key={index} className="flex h-13 shrink-0 items-center gap-3 px-2">
              <Skeleton className="size-row shrink-0 rounded-xs" />
              <div className="flex min-w-0 grow flex-col gap-px">
                <SkeletonLine className="font-sans text-base/sm" bar="h-2.5 w-45 max-w-full" />
                <SkeletonLine className="font-sans text-sm/xs" bar="h-2.5 w-27.5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ArtistPage() {
  const { artistId } = Route.useParams();
  const music = useMusic();
  const detail = useRead(music.artists.get, { artistId });
  const albums = useAllRows(music.artists.albums, pagesOf(artistId));
  const play = usePlayTracks();

  if (detail === undefined || albums === undefined) return <ArtistSkeleton />;

  const { artist, topTracks } = detail;
  const latest = albums.toSorted((left, right) => (right.year ?? 0) - (left.year ?? 0))[0];
  const [from] = placeholderColors(latest?.id ?? artist.id);

  // An artist without a song count of their own counts their albums' songs.
  const songCount =
    artist.trackCount ?? albums.reduce((total, album) => total + album.trackCount, 0);

  const facts = [
    "Artist",
    albums.length === 0 ? null : plural(albums.length, "album"),
    `${plural(songCount, "song")} in your library`,
  ]
    .filter((fact) => fact !== null)
    .join(" · ");

  return (
    <div className="flex flex-col gap-8 pb-12">
      <header
        className="relative flex h-65 shrink-0 flex-col justify-end gap-3.5 overflow-hidden px-5 pb-7 lg:h-75 lg:px-12"
        style={{
          backgroundImage: `linear-gradient(in oklab 180deg, transparent 30%, color-mix(in oklab, var(--color-dark-hero-scrim) 55%, transparent) 100%), linear-gradient(in oklab 120deg, var(--color-dark-hero-start) 0%, var(--color-dark-hero-end) 60%, ${from} 100%)`,
        }}
      >
        {artist.artUrl === null ? null : (
          <img
            src={artSrc(artist.artUrl)}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-60"
          />
        )}
        <span className="relative font-mono text-xs/xs tracking-mono text-dark-text/75 uppercase">
          {facts}
        </span>
        <div className="relative flex items-center gap-4">
          <button
            type="button"
            aria-label={`Play ${artist.name}`}
            disabled={topTracks.length === 0}
            onClick={() => void play(topTracks)}
            className="flex size-13 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-dark-text/60"
          >
            <PlayIcon className="size-5 translate-x-px" fill="currentColor" strokeWidth={0} />
          </button>
          <h1 className="min-w-0 grow font-sans text-phone-large-title leading-10.25 font-heavy tracking-tighter text-dark-text lg:text-display/display lg:tracking-display">
            {artist.name}
          </h1>
          <CollectionMenu
            tracks={topTracks}
            label={artist.name}
            link={{ kind: "artist", id: artist.id }}
            className="border-dark-text/40 text-dark-text hover:bg-dark-text/15 data-popup-open:bg-dark-text/15"
          />
        </div>
      </header>

      <div className="flex flex-col gap-12 px-5 lg:flex-row lg:px-12">
        {latest === undefined ? null : (
          <section className="flex w-full shrink-0 flex-col gap-3.5 lg:w-sidebar">
            <h2 className="font-sans text-lg/lg font-semibold tracking-tight text-text">
              Latest in library
            </h2>
            <Link
              to="/albums/$albumId"
              params={{ albumId: latest.id }}
              className="flex flex-col gap-3.5"
            >
              <Artwork
                url={latest.artUrl}
                seed={latest.id}
                className="aspect-square w-full max-w-sidebar rounded-md"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-sans text-base/sm font-medium text-text">{latest.title}</span>
                <span className="font-sans text-sm/xs text-text-muted">
                  {[latest.year, plural(latest.trackCount, "song")]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              </span>
            </Link>
          </section>
        )}
        <ArtistSongs artistId={artist.id} topTracks={topTracks} />
      </div>

      {albums.length > 1 ? (
        <section className="flex flex-col gap-4 px-5 lg:px-12">
          <SectionHeader title="Albums" />
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:gap-5 xl:grid-cols-6">
            {albums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                subtitle={
                  album.year === null ? plural(album.trackCount, "song") : String(album.year)
                }
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** `tracks` without a later row of a song already listed, as two pages may both hold one. */
const distinctSongs = (tracks: ReadonlyArray<Track>): ReadonlyArray<Track> => {
  const seen = new Set<Track["id"]>();

  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;

    seen.add(track.id);

    return true;
  });
};

/**
 * Every song crediting the artist, by title: their own and the ones they feature on, each once.
 * It lists the first `TOP_SONGS` until "Show all songs", then pages the rest in as the end
 * scrolls near. Until the first page arrives it lists the top songs, which are the same first
 * songs by title.
 */
function ArtistSongs({
  artistId,
  topTracks,
}: {
  readonly artistId: ArtistId;
  readonly topTracks: ReadonlyArray<Track>;
}) {
  const music = useMusic();
  const paged = usePages(music.artists.tracks, pagesOf(artistId), PAGE_ROWS);
  const play = usePlayTracks();
  const [all, setAll] = useState(false);
  const headingId = useId();
  const next = paged.status === "ready" ? paged.next : null;
  const songs = paged.status === "ready" ? distinctSongs(paged.rows) : topTracks;
  const short = !all && songs.length < TOP_SONGS && next?.kind === "more" ? next.load : null;

  // A page can end before the first songs do, where the artist's linked songs end: load on.
  useEffect(() => short?.(), [short]);

  if (paged.status === "failed") throw new Error(paged.message);

  const shown = all ? songs : songs.slice(0, TOP_SONGS);
  const more = songs.length > TOP_SONGS || (songs.length === TOP_SONGS && next?.kind === "more");

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 grow flex-col gap-1.5">
      <h2
        id={headingId}
        className="pb-2 font-sans text-lg/lg font-semibold tracking-tight text-text"
      >
        Songs
      </h2>
      {shown.map((track, index) => (
        <SongRow
          key={track.id}
          track={track}
          artistId={artistId}
          onPlay={() => void play(songs, { index })}
        />
      ))}
      {all && paged.status === "ready" ? (
        <ListTail
          paged={paged}
          skeleton={<SkeletonLine className="h-13 px-2 font-sans text-base/sm" bar="h-2.5 w-45" />}
        />
      ) : null}
      {more && !all ? (
        <div className="pt-2">
          <Button variant="secondary" size="sm" onClick={() => setAll(true)}>
            Show all songs
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One of the artist's songs: its album, and the song's artists first when it credits anyone else,
 * as a song they feature on does.
 */
function SongRow({
  track,
  artistId,
  onPlay,
}: {
  readonly track: Track;
  readonly artistId: ArtistId;
  readonly onPlay: () => void;
}) {
  const player = usePlayer();
  const desktop = useIsDesktop();
  const current = player.track?.id === track.id;
  const shared = creditsOf(track).some((credit) => credit.artistId !== artistId);

  return (
    <div
      className="group/row relative flex h-13 shrink-0 items-center gap-3 rounded-sm px-2 hover:bg-surface"
      onDoubleClick={onPlay}
    >
      <button
        type="button"
        aria-label={`Play ${track.title}`}
        onClick={onPlay}
        className="absolute inset-0 lg:hidden"
      />
      <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-xs">
        {current ? (
          <span className="absolute inset-0 flex items-end justify-center pb-2.5">
            <PlayingBars />
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Play ${track.title}`}
            onClick={onPlay}
            className="absolute inset-0 flex items-center justify-center bg-dark-canvas/30 text-dark-text outline-none pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <PlayIcon className="size-4" fill="currentColor" strokeWidth={0} />
          </button>
        )}
      </Artwork>
      <span className="flex min-w-0 grow flex-col gap-px">
        <span
          className={cn("truncate font-sans text-base/sm text-text", current && "font-semibold")}
        >
          {track.title}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">
          {shared ? (
            <>
              {/* On a phone the row is one play button, so the names are text and its menu
                  opens each artist. */}
              <ArtistCredits item={track} links={desktop} />
              {" · "}
            </>
          ) : null}
          {track.album}
        </span>
      </span>
      <LikeButton
        track={track}
        className={cn(
          "relative hidden size-9 opacity-0 group-hover/row:opacity-100 lg:flex",
          track.liked && "opacity-100",
        )}
        iconClassName="size-4.5"
      />
      <span className="hidden w-12 shrink-0 text-right font-mono text-sm/xs text-text-muted lg:block">
        {formatDuration(track.durationMs)}
      </span>
      <TrackMenu
        track={track}
        className="relative lg:opacity-0 lg:group-hover/row:opacity-100 lg:data-popup-open:opacity-100"
      />
    </div>
  );
}

function ArtistError(props: ErrorComponentProps) {
  return <DetailError {...props} copy={MISSING} />;
}
