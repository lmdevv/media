import { ArtistId } from "@music/commands/ids";
import type { Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { PlayIcon } from "lucide-react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { AlbumCard, SectionHeader, usePlayTracks } from "@/components/library/cards";
import { LikeButton } from "@/components/library/like-button";
import { TrackMenu } from "@/components/playlists/track-menu";
import { placeholderColors } from "@/lib/art";
import { formatDuration, plural } from "@/lib/format";

const decodeArtistId = Schema.decodeUnknownSync(ArtistId);

export const Route = createFileRoute("/_app/artists/$artistId")({
  params: {
    parse: (params) => ({ artistId: decodeArtistId(params.artistId) }),
    stringify: (params) => ({ artistId: params.artistId }),
  },
  component: ArtistPage,
});

function ArtistPage() {
  const { artistId } = Route.useParams();
  const detail = useRead("artists.get", { artistId });
  const play = usePlayTracks();

  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-8">
        <Skeleton className="h-[300px] w-full rounded-none" />
        <div className="px-12">
          <Skeleton className="h-4 w-48" />
        </div>
      </div>
    );
  }

  const { artist, albums, topTracks } = detail;
  const latest = albums.toSorted((left, right) => (right.year ?? 0) - (left.year ?? 0))[0];
  const songCount = albums.reduce((total, album) => total + album.trackCount, 0);
  const [from] = placeholderColors(latest?.id ?? artist.id);

  return (
    <div className="flex flex-col gap-8 pb-12">
      <header
        className="relative flex h-[260px] shrink-0 flex-col justify-end gap-3.5 overflow-hidden px-5 pb-7 lg:h-[300px] lg:px-12"
        style={{
          backgroundImage: `linear-gradient(in oklab 180deg, oklab(14.5% 0 0 / 0%) 30%, oklab(14.5% 0 0 / 55%) 100%), linear-gradient(in oklab 120deg, oklab(34.8% 0 0) 0%, oklab(19.6% 0 0) 60%, ${from} 100%)`,
        }}
      >
        {artist.artUrl === null ? null : (
          <img
            src={artist.artUrl}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-60"
          />
        )}
        <span className="relative font-mono text-xs/xs tracking-mono text-white/75 uppercase">
          Artist · {plural(albums.length, "album")} · {plural(songCount, "song")} in your library
        </span>
        <div className="relative flex items-center gap-4">
          <button
            type="button"
            aria-label={`Play ${artist.name}`}
            disabled={topTracks.length === 0}
            onClick={() => void play(topTracks)}
            className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-accent text-on-accent outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <PlayIcon className="size-5 translate-x-px" fill="currentColor" strokeWidth={0} />
          </button>
          <h1 className="font-sans text-[34px] leading-[41px] font-heavy tracking-[-0.02em] text-white lg:text-display/display lg:tracking-display">
            {artist.name}
          </h1>
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
        <section className="flex min-w-0 grow flex-col gap-1.5">
          <h2 className="pb-2 font-sans text-lg/lg font-semibold tracking-tight text-text">
            Top songs
          </h2>
          {topTracks.map((track, index) => (
            <TopSongRow
              key={track.id}
              track={track}
              onPlay={() => void play(topTracks, { index })}
            />
          ))}
        </section>
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

function TopSongRow({ track, onPlay }: { readonly track: Track; readonly onPlay: () => void }) {
  const player = usePlayer();
  const current = player.track?.id === track.id;

  return (
    <div
      className="group/row relative flex h-[52px] shrink-0 items-center gap-3 rounded-sm px-2 hover:bg-surface"
      onDoubleClick={onPlay}
    >
      <button
        type="button"
        aria-label={`Play ${track.title}`}
        onClick={onPlay}
        className="absolute inset-0 lg:hidden"
      />
      <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-[4px]">
        {current ? (
          <span className="absolute inset-0 flex items-end justify-center pb-2.5">
            <PlayingBars />
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Play ${track.title}`}
            onClick={onPlay}
            className="absolute inset-0 hidden items-center justify-center bg-black/30 text-white outline-none group-hover/row:flex focus-visible:flex"
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
        <span className="truncate font-sans text-sm/xs text-text-muted">{track.album}</span>
      </span>
      <LikeButton
        track={track}
        className={cn(
          "relative hidden size-9 opacity-0 group-hover/row:opacity-100 lg:flex",
          track.liked && "opacity-100",
        )}
        iconClassName="size-[18px]"
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
