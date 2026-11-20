import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  DiscIcon,
  HeartIcon,
  ListMusicIcon,
  MusicIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Artwork } from "@/components/library/artwork";
import { AlbumCard, PageHeader, SectionHeader } from "@/components/library/cards";
import { plural } from "@/lib/format";
import type { PageOpts } from "@media/ui/lib/pages";
import { preloadAllRows, useAllRows } from "@/lib/pages";
import { useMusic, useRead } from "@/lib/platform";

/** The arguments of each page of playlists shared with you, shared by the loader and the page. */
const sharedPage = (paginationOpts: PageOpts) => ({ paginationOpts });

export const Route = createFileRoute("/_app/library")({
  loader: async ({ context: { platform } }) => {
    await Promise.all([
      platform.music.library.home.preload({}),
      preloadAllRows(platform.music.playlists.shared, sharedPage),
    ]);
  },
  pendingComponent: LibrarySkeleton,
  component: LibraryPage,
});

const LINKS: ReadonlyArray<{
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { to: "/playlists", label: "Playlists", icon: ListMusicIcon },
  { to: "/artists", label: "Artists", icon: UserRoundIcon },
  { to: "/albums", label: "Albums", icon: DiscIcon },
  { to: "/songs", label: "Songs", icon: MusicIcon },
  { to: "/liked", label: "Liked songs", icon: HeartIcon },
];

const nav = (
  <nav aria-label="Library" className="flex flex-col">
    {LINKS.map((link) => (
      <Link
        key={link.label}
        to={link.to}
        className="flex h-12 items-center gap-3.5 border-b-hairline border-border font-sans text-lg leading-lg text-text"
      >
        <link.icon aria-hidden className="size-6 text-accent" />
        <span className="grow">{link.label}</span>
        <ChevronRightIcon aria-hidden className="size-5 text-text-muted" />
      </Link>
    ))}
  </nav>
);

const gridClassName = "grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-6";

/** The links, which need no data, above a skeleton of the Recently Added row. */
function LibrarySkeleton() {
  return (
    <div className="flex flex-col gap-6 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader title="Library" />
      {nav}
      <div aria-hidden className="flex flex-col gap-3 pt-2">
        <SkeletonLine
          className="font-sans text-phone-title leading-lg lg:text-lg/lg"
          bar="h-4 w-36"
        />
        <div className={gridClassName}>
          {Array.from({ length: 6 }, (_, index) => (
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
    </div>
  );
}

function LibraryPage() {
  const music = useMusic();
  const home = useRead(music.library.home, {});
  const shared = useAllRows(music.playlists.shared, sharedPage);

  if (home === undefined || shared === undefined) return <LibrarySkeleton />;

  return (
    <div className="flex flex-col gap-6 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader title="Library" />
      {nav}
      {shared.length === 0 ? null : (
        <section aria-label="Shared with you" className="flex flex-col gap-3 pt-2">
          <SectionHeader title="Shared with you" to="/playlists" />
          <div className={gridClassName}>
            {shared.map((playlist) => (
              <Link
                key={playlist.id}
                to="/playlists/$playlistId"
                params={{ playlistId: playlist.id }}
                className="flex min-w-0 flex-col gap-2"
              >
                <Artwork
                  url={playlist.artUrls[0] ?? null}
                  seed={playlist.id}
                  className="aspect-square w-full rounded-md"
                />
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate font-sans text-base/sm font-medium text-text">
                    {playlist.name}
                  </span>
                  <span className="truncate font-sans text-sm/xs text-text-muted">
                    {playlist.owner?.name ?? "Someone"} · {plural(playlist.trackCount, "song")}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {home.recentlyAdded.length > 0 ? (
        <section className="flex flex-col gap-3 pt-2">
          <SectionHeader title="Recently Added" to="/albums" />
          <div className={gridClassName}>
            {home.recentlyAdded.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
