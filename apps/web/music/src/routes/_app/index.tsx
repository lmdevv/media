import { usePlayer } from "@media/player/react";
import { buttonClassName } from "@/components/ui/button";
import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DiscIcon, FolderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import { ProgressBar, useActiveScan } from "@/components/library/scans";
import type { ActiveScan } from "@/components/library/scans";
import { ACCOUNT_LIBRARIES } from "@/lib/account-links";
import { jobEta, jobPercent } from "@/lib/job-progress";
import type { AlbumCard as Album } from "@/lib/models";
import type { PageOpts } from "@media/ui/lib/pages";
import { preloadAllRows, useAllRows } from "@/lib/pages";
import { can } from "@/lib/permissions";
import { nameOf, useMe, useMusic, useRead } from "@/lib/platform";
import {
  AlbumCard,
  AlbumRowSkeleton,
  ArtistCircle,
  PageHeader,
  QuickTile,
  SectionHeader,
} from "@/components/library/cards";
import { formatCount, formatTotal, greeting, initial, weekday } from "@/lib/format";
import { placeholderAt } from "@/lib/art";
import { useNow } from "@/lib/use-now";

const playlistsPage = (paginationOpts: PageOpts) => ({ paginationOpts });

export const Route = createFileRoute("/_app/")({
  loader: async ({ context: { platform } }) => {
    // The signed-in shell owns the session query, which the greeting reads, and its failure screen.
    await Promise.all([
      platform.music.library.home.preload({}),
      // The quick tiles mix playlists with albums, so they wait for both rather than reshuffle.
      preloadAllRows(platform.music.playlists.list, playlistsPage),
    ]);
  },
  pendingComponent: HomeSkeleton,
  component: HomeScreen,
});

const firstName = (name: string): string => name.split(/\s+/)[0] ?? "";

function HomeScreen() {
  const active = useActiveScan();
  const music = useMusic();
  const home = useRead(music.library.home, {});
  const me = useMe();
  const playlists = useAllRows(music.playlists.list, playlistsPage);
  const player = usePlayer();
  const now = useNow(60_000);

  if (home === undefined || me === undefined) return <HomeSkeleton />;

  // A library with songs shows at once and its scan banner once the scan is known; an empty one
  // waits for it, so it never flashes the empty state while its first scan runs.
  if (home.stats.tracks === 0 && active === undefined) return <HomeSkeleton />;

  const scan = active ?? undefined;
  const name = firstName(nameOf(me));

  if (home.stats.tracks === 0 && scan === undefined)
    return <EmptyLibrary admin={can(me.role, "admin")} />;

  const tiles: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly artUrl: string | null;
    readonly seed: string;
    readonly link: ReactNode;
    readonly playing: boolean;
  }> = [
    ...home.recentlyPlayed.map((album) =>
      albumTile(album, player.track?.albumId === album.id && player.status === "playing"),
    ),
    ...(playlists ?? []).map((playlist) => ({
      key: playlist.id,
      title: playlist.name,
      artUrl: playlist.artUrls[0] ?? null,
      seed: playlist.id,
      playing: false,
      link: (
        <Link
          to="/playlists/$playlistId"
          params={{ playlistId: playlist.id }}
          aria-label={playlist.name}
          className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      ),
    })),
    ...home.recentlyAdded.map((album) => albumTile(album, false)),
  ]
    .filter((tile, index, all) => all.findIndex((other) => other.key === tile.key) === index)
    .slice(0, 6);

  const artists = home.recentlyPlayedArtists.slice(0, 6);

  const scanning = scan !== undefined;

  return (
    <>
      <div className="hidden flex-col gap-row px-12 pt-row pb-12 lg:flex">
        <PageHeader
          eyebrow={
            scanning && home.stats.tracks === 0
              ? "First scan in progress"
              : `${weekday(now)} · ${formatCount(home.stats.tracks)} songs · ${formatTotal(home.stats.durationMs)}`
          }
          title={
            scanning && home.stats.tracks === 0 ? `Welcome, ${name}` : `${greeting(now)}, ${name}`
          }
        />
        {scan === undefined ? null : <ScanBanner job={scan} />}
        {tiles.length > 0 && !(scanning && home.recentlyPlayed.length === 0) ? (
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {tiles.map((tile) => (
              <QuickTile
                key={tile.key}
                title={tile.title}
                artUrl={tile.artUrl}
                seed={tile.seed}
                to={tile.link}
                playing={tile.playing}
              />
            ))}
          </div>
        ) : null}
        <section className="flex flex-col gap-4">
          <SectionHeader title={scanning ? "Just found" : "Recently added"} to="/albums" />
          <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
            {home.recentlyAdded.slice(0, 6).map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
        {scanning ? <AlbumRowSkeleton /> : null}
        {artists.length > 0 && !scanning ? (
          <section className="flex flex-col gap-4">
            <SectionHeader title="Recently played artists" to="/artists" />
            <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
              {artists.map((artist) => (
                <ArtistCircle key={artist.id} artist={artist} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <PhoneHome
        name={nameOf(me)}
        picks={home.recentlyPlayed.length > 0 ? home.recentlyPlayed : home.recentlyAdded}
        picksLabel={home.recentlyPlayed.length > 0 ? "Recently played" : "Recently added"}
        recent={home.recentlyAdded}
        scan={scan === undefined ? null : <ScanBanner job={scan} />}
      />
    </>
  );
}

const albumTile = (album: Album, playing: boolean) => ({
  key: album.id,
  title: album.title,
  artUrl: album.artUrl,
  seed: album.id,
  playing,
  link: (
    <Link
      to="/albums/$albumId"
      params={{ albumId: album.id }}
      aria-label={album.title}
      className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  ),
});

function ScanBanner({ job }: { readonly job: ActiveScan }) {
  const now = useNow(1000, job.status === "running");
  const path = job.library;
  const percent = jobPercent(job) ?? 0;
  const eta = jobEta(job, now);

  return (
    <output className="flex flex-col gap-2.5 rounded-md bg-surface px-4 py-3.5">
      <span className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
        <span className="grow font-sans text-base/sm font-medium text-text">
          {job.status === "queued"
            ? `Waiting to scan ${path}.`
            : `Scanning ${path}. New albums appear as they're found.`}
        </span>
        {job.status === "queued" ? null : (
          <span className="font-mono text-xs/xs tracking-mono text-text-muted">
            {job.total === null
              ? formatCount(job.done ?? 0)
              : `${formatCount(job.done ?? 0)} / ${formatCount(job.total)}`}
            {eta === null ? "" : ` · ${eta}`}
          </span>
        )}
      </span>
      <ProgressBar percent={percent} className="h-0.75" label={`Scanning ${path}`} />
    </output>
  );
}

function EmptyLibrary({ admin }: { readonly admin: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-12 text-center lg:min-h-dvh-inset-sm">
      <div className="flex size-24 shrink-0 items-center justify-center rounded-full bg-surface">
        <DiscIcon aria-hidden className="size-10 text-text-muted" strokeWidth={1.25} />
      </div>
      <div className="flex max-w-120 flex-col items-center gap-2.5">
        <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
          Nothing to play yet
        </h1>
        <p className="font-sans text-md/md text-text-muted">
          {admin
            ? "Point Lar Music at the folder where your music lives. Files stay where they are. We only read them."
            : "No library folder is shared with you yet. Ask an admin to add one, or to add you to theirs."}
        </p>
      </div>
      {admin ? (
        <a
          href={ACCOUNT_LIBRARIES}
          className={buttonClassName({ variant: "solid", className: "pl-4" })}
        >
          <FolderIcon aria-hidden />
          Add a library folder
        </a>
      ) : null}
    </div>
  );
}

const SIX = Array.from({ length: 6 }, (_, index) => index);

/** A desktop section title's line. */
const sectionTitle = <SkeletonLine className="font-sans text-lg/lg" bar="h-3.5 w-45" />;

/** A phone section title's line. */
const phoneSectionTitle = (
  <SkeletonLine className="px-5 font-sans text-phone-title leading-lg" bar="h-4 w-36" />
);

/** Home's shape while it loads, at desktop and phone width, laid out as the loaded page is. */
function HomeSkeleton() {
  return (
    <div aria-hidden>
      <div className="hidden flex-col gap-row px-12 pt-row pb-12 lg:flex">
        <div className="flex flex-col gap-1.5">
          <SkeletonLine className="font-mono text-xs/xs" bar="h-3 w-56" />
          <SkeletonLine className="font-sans text-2xl/2xl" bar="h-8 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
          {SIX.map((index) => (
            <Skeleton key={index} className="h-row-touch rounded-sm" />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {sectionTitle}
          <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
            {SIX.map((index) => (
              <div key={index} className="flex flex-col gap-2.5">
                <Skeleton className="aspect-square w-full rounded-md" />
                <div className="flex flex-col gap-0.5">
                  <SkeletonLine className="font-sans text-base/sm" bar="h-2.5 w-[70%]" />
                  <SkeletonLine className="font-sans text-sm/xs" bar="h-2.5 w-[45%]" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          {sectionTitle}
          <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
            {SIX.map((index) => (
              <div key={index} className="flex flex-col items-center gap-2.5">
                <Skeleton className="aspect-square w-full rounded-full" />
                <SkeletonLine className="font-sans text-base/sm" bar="h-2.5 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-7.5 pt-safe-top lg:hidden">
        <div className="flex items-end justify-between px-5">
          <span className="font-sans text-phone-large-title leading-10.25 font-heavy tracking-tighter text-text">
            Home
          </span>
          <Skeleton className="mb-1 size-8.5 rounded-full" />
        </div>
        <div className="flex flex-col gap-3">
          {phoneSectionTitle}
          <div className="flex gap-3 overflow-hidden px-5">
            {SIX.slice(0, 2).map((index) => (
              <div key={index} className="flex w-62.5 shrink-0 flex-col gap-2">
                <SkeletonLine className="font-sans text-sm/xs" bar="h-2.5 w-24" />
                <Skeleton className="h-80 w-62.5 rounded-phone-card" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {phoneSectionTitle}
          <div className="flex gap-3 overflow-hidden px-5">
            {SIX.slice(0, 3).map((index) => (
              <div key={index} className="flex w-42.5 shrink-0 flex-col gap-1.5">
                <Skeleton className="size-42.5 rounded-phone-art" />
                <div className="flex flex-col">
                  <SkeletonLine className="font-sans text-sm/sm" bar="h-2.5 w-28" />
                  <SkeletonLine className="font-sans text-sm/sm" bar="h-2.5 w-20" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneHome({
  name,
  picks,
  picksLabel,
  recent,
  scan,
}: {
  readonly name: string;
  readonly picks: ReadonlyArray<Album>;
  readonly picksLabel: string;
  readonly recent: ReadonlyArray<Album>;
  readonly scan: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-7.5 pt-safe-top lg:hidden">
      <div className="flex items-end justify-between px-5">
        <h1 className="font-sans text-phone-large-title leading-10.25 font-heavy tracking-tighter text-text">
          Home
        </h1>
        <Link
          to="/settings"
          aria-label="Settings"
          className="mb-1 flex size-8.5 items-center justify-center rounded-full font-sans text-base/sm font-semibold text-text-inverse dark:text-text"
          style={{ backgroundImage: placeholderAt(1) }}
        >
          {initial(name)}
        </Link>
      </div>
      {scan === null ? null : <div className="px-5">{scan}</div>}
      {picks.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Top Picks" to="/albums" className="px-5" />
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-5 px-5 [scrollbar-width:none]">
            {picks.slice(0, 8).map((album, index) => (
              <Link
                key={album.id}
                to="/albums/$albumId"
                params={{ albumId: album.id }}
                className="flex w-62.5 shrink-0 snap-start flex-col gap-2"
              >
                <span className="font-sans text-sm/xs text-text-muted">
                  {index === 0 ? picksLabel : album.artist}
                </span>
                <Artwork
                  url={album.artUrl}
                  seed={album.id}
                  className="flex h-80 w-62.5 flex-col justify-end rounded-phone-card p-4"
                >
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-dark-canvas/65 to-transparent"
                  />
                  <span className="relative font-sans text-phone-card leading-lg font-heavy tracking-snug text-dark-text drop-shadow-sm">
                    {album.title}
                  </span>
                  <span className="relative pt-1 font-sans text-sm/sm text-dark-text/75">
                    {album.artist}
                  </span>
                </Artwork>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {recent.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Recently Added" to="/albums" className="px-5" />
          <div className="flex snap-x gap-3 overflow-x-auto scroll-px-5 px-5 [scrollbar-width:none]">
            {recent.map((album) => (
              <Link
                key={album.id}
                to="/albums/$albumId"
                params={{ albumId: album.id }}
                className="flex w-42.5 shrink-0 snap-start flex-col gap-1.5"
              >
                <Artwork
                  url={album.artUrl}
                  seed={album.id}
                  className="size-42.5 rounded-phone-art"
                />
                <span className="flex flex-col">
                  <span className="truncate font-sans text-sm/sm text-text">{album.title}</span>
                  <span className="truncate font-sans text-sm/sm text-text-muted">
                    {album.artist}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
