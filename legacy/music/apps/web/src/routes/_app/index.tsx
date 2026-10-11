import type { AlbumCard as Album, Job } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { buttonClassName } from "@music/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DiscIcon, FolderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProgressBar, jobEta, jobPercent } from "@/components/auth/scan-progress";
import { Artwork } from "@/components/library/artwork";
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

export const Route = createFileRoute("/_app/")({ component: HomePage });

const firstName = (name: string | null, email: string): string =>
  (name ?? email).split(/\s+/)[0] ?? "";

function HomePage() {
  const home = useRead("library.home", {});
  const me = useRead("account.me", {});
  const jobs = useRead("jobs.list", {});
  const playlists = useRead("playlists.list", {});
  const player = usePlayer();
  const now = useNow(60_000);

  if (home === undefined || me === undefined || jobs === undefined) return <HomeSkeleton />;

  const scan = jobs.find((job) => job.status === "running" || job.status === "pending");

  const name = firstName(me.name, me.email);

  if (home.stats.tracks === 0 && scan === undefined)
    return <EmptyLibrary admin={me.role === "admin"} />;

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
        name={me.name ?? me.email}
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

function ScanBanner({ job }: { readonly job: Job }) {
  const now = useNow(1000, job.status === "running");
  const libraries = useRead("libraries.list", {});
  const path = libraries?.find((library) => library.id === job.libraryId)?.path ?? "your library";
  const percent = jobPercent(job) ?? 0;
  const eta = jobEta(job, now);

  return (
    <div role="status" className="flex flex-col gap-2.5 rounded-md bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
        <span className="grow font-sans text-base/sm font-medium text-text">
          {job.status === "pending"
            ? `Waiting to scan ${path}.`
            : `Scanning ${path}. New albums appear as they're found.`}
        </span>
        {job.status === "pending" ? null : (
          <span className="font-mono text-xs/xs tracking-mono text-text-muted">
            {job.total === null
              ? formatCount(job.done)
              : `${formatCount(job.done)} / ${formatCount(job.total)}`}
            {eta === null ? "" : ` · ${eta}`}
          </span>
        )}
      </div>
      <ProgressBar percent={percent} className="h-[3px]" label={`Scanning ${path}`} />
    </div>
  );
}

function EmptyLibrary({ admin }: { readonly admin: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-12 text-center lg:min-h-[calc(100dvh-16px)]">
      <div className="flex size-24 shrink-0 items-center justify-center rounded-full bg-surface">
        <DiscIcon aria-hidden className="size-10 text-text-muted" strokeWidth={1.25} />
      </div>
      <div className="flex max-w-[480px] flex-col items-center gap-2.5">
        <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
          Nothing to play yet
        </h1>
        <p className="font-sans text-md/md text-text-muted">
          {admin
            ? "Point [music] at the folder where your music lives. Files stay where they are. We only read them."
            : "An admin hasn't shared a library folder yet. Ask them to add one in Settings → Libraries."}
        </p>
      </div>
      {admin ? (
        <>
          <Link
            to="/settings/libraries"
            search={{ add: "1" }}
            className={buttonClassName({ variant: "solid", className: "pl-4" })}
          >
            <FolderIcon aria-hidden />
            Add a library folder
          </Link>
          <div className="flex items-center gap-3 rounded-md border border-border px-3.5 py-2.5">
            <span className="font-mono text-xs/xs tracking-mono text-text-muted">
              OR FROM A TERMINAL
            </span>
            <code className="font-mono text-sm/xs text-text">
              music libraries create --name Music --path /music
            </code>
          </div>
        </>
      ) : null}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-row px-5 pt-row lg:px-12">
      <div className="h-[70px]" />
      <AlbumRowSkeleton title={false} />
      <AlbumRowSkeleton />
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
    <div className="flex flex-col gap-[30px] pt-[max(16px,env(safe-area-inset-top))] lg:hidden">
      <div className="flex items-end justify-between px-5">
        <h1 className="font-sans text-[34px] leading-[41px] font-heavy tracking-[-0.02em] text-text">
          Home
        </h1>
        <Link
          to="/settings"
          aria-label="Settings"
          className="mb-1 flex size-[34px] items-center justify-center rounded-full font-sans text-base/sm font-semibold text-text-inverse dark:text-text"
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
                className="flex w-[250px] shrink-0 snap-start flex-col gap-2"
              >
                <span className="font-sans text-sm/xs text-text-muted">
                  {index === 0 ? picksLabel : album.artist}
                </span>
                <Artwork
                  url={album.artUrl}
                  seed={album.id}
                  className="flex h-[320px] w-[250px] flex-col justify-end rounded-[14px] p-4"
                >
                  {/* Paper's placeholder art is dark; real covers can be light, so the white
                      title gets a scrim to stay readable. */}
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-dark-canvas/65 to-transparent"
                  />
                  <span className="relative font-sans text-[24px] leading-lg font-heavy tracking-[-0.01em] text-white drop-shadow-sm">
                    {album.title}
                  </span>
                  <span className="relative pt-1 font-sans text-sm/sm text-white/75">
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
                className="flex w-[170px] shrink-0 snap-start flex-col gap-1.5"
              >
                <Artwork
                  url={album.artUrl}
                  seed={album.id}
                  className="size-[170px] rounded-[10px]"
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
