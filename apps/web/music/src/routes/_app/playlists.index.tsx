import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon, HeartIcon, PlusIcon } from "lucide-react";

import { Artwork } from "@/components/library/artwork";
import { PageHeader } from "@/components/library/cards";
import { useUi } from "@/components/shell/ui-state";
import { formatAgo, plural } from "@/lib/format";
import type { PageOpts } from "@media/ui/lib/pages";
import { preloadAllRows, useAllRows } from "@/lib/pages";
import { useMusic } from "@/lib/platform";

/** The arguments of each page of your playlists, shared by the loader and the page. */
const playlistsPage = (paginationOpts: PageOpts) => ({ paginationOpts });

/** The arguments of each page of playlists shared with you, shared by the loader and the page. */
const sharedPage = (paginationOpts: PageOpts) => ({ paginationOpts });

export const Route = createFileRoute("/_app/playlists/")({
  loader: async ({ context: { platform } }) => {
    // Shared with you, started with your playlists so it arrives with them.
    void preloadAllRows(platform.music.playlists.shared, sharedPage);
    await preloadAllRows(platform.music.playlists.list, playlistsPage);
  },
  pendingComponent: PlaylistsSkeleton,
  component: PlaylistsPage,
});

const rowClassName =
  "flex h-18 shrink-0 items-center gap-3.5 border-b-hairline border-border pr-1 outline-none focus-visible:bg-surface lg:h-16 lg:rounded-sm lg:border-b-0 lg:px-2 lg:hover:bg-surface";

const likedRow = (
  <Link to="/liked" className={rowClassName}>
    <span className="flex size-14 shrink-0 items-center justify-center rounded-sm bg-text lg:size-12">
      <HeartIcon aria-hidden className="size-6 text-accent" fill="currentColor" strokeWidth={0} />
    </span>
    <span className="flex min-w-0 grow flex-col gap-px">
      <span className="truncate font-sans text-md/base text-text lg:text-base/sm lg:font-medium">
        Liked songs
      </span>
      <span className="font-sans text-sm/xs text-text-muted">Private to you</span>
    </span>
    <ChevronRightIcon aria-hidden className="size-5 text-text-muted" />
  </Link>
);

function PlaylistsHeader({ eyebrow }: { readonly eyebrow: string | null }) {
  const { openNewPlaylist } = useUi();

  return (
    <PageHeader
      title="Playlists"
      eyebrow={eyebrow}
      actions={
        <Button variant="solid" className="pl-3.5" onClick={() => openNewPlaylist()}>
          <PlusIcon />
          New playlist
        </Button>
      }
    />
  );
}

function PlaylistsSkeleton() {
  return (
    <div className="flex flex-col gap-6 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PlaylistsHeader eyebrow={null} />
      <div className="flex flex-col">
        {likedRow}
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            aria-hidden
            className="flex h-18 shrink-0 items-center gap-3.5 border-b-hairline border-border pr-1 lg:h-16 lg:border-b-0 lg:px-2"
          >
            <Skeleton className="size-14 shrink-0 rounded-sm lg:size-12" />
            <span className="flex min-w-0 grow flex-col gap-px">
              <SkeletonLine
                className="font-sans text-md/base lg:text-base/sm"
                bar="h-2.5 w-40 max-w-full"
              />
              <SkeletonLine className="font-sans text-sm/xs" bar="h-2.5 w-28" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaylistsPage() {
  const music = useMusic();
  const playlists = useAllRows(music.playlists.list, playlistsPage);
  const shared = useAllRows(music.playlists.shared, sharedPage);

  if (playlists === undefined) return <PlaylistsSkeleton />;

  return (
    <div className="flex flex-col gap-6 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PlaylistsHeader eyebrow={plural(playlists.length, "playlist")} />
      <div className="flex flex-col">
        {likedRow}
        {playlists.map((playlist) => (
          <Link
            key={playlist.id}
            to="/playlists/$playlistId"
            params={{ playlistId: playlist.id }}
            className={rowClassName}
          >
            <Artwork
              url={playlist.artUrls[0] ?? null}
              seed={playlist.id}
              className="size-14 rounded-sm lg:size-12"
            />
            <span className="flex min-w-0 grow flex-col gap-px">
              <span className="truncate font-sans text-md/base text-text lg:text-base/sm lg:font-medium">
                {playlist.name}
              </span>
              <span className="truncate font-sans text-sm/xs text-text-muted">
                {plural(playlist.trackCount, "song")} · updated {formatAgo(playlist.updatedAt)}
              </span>
            </span>
            <ChevronRightIcon aria-hidden className="size-5 text-text-muted" />
          </Link>
        ))}
        {playlists.length === 0 ? (
          <p className="py-4 font-sans text-md/md text-text-muted lg:px-2">
            Playlists you make show up here. Start one with New playlist, or from any song's menu.
          </p>
        ) : null}
      </div>
      {shared === undefined || shared.length === 0 ? null : (
        <section aria-label="Shared with you" className="flex flex-col gap-2">
          <h2 className="font-sans text-lg/lg font-semibold tracking-tight text-text">
            Shared with you
          </h2>
          <div className="flex flex-col">
            {shared.map((playlist) => (
              <Link
                key={playlist.id}
                to="/playlists/$playlistId"
                params={{ playlistId: playlist.id }}
                className={rowClassName}
              >
                <Artwork
                  url={playlist.artUrls[0] ?? null}
                  seed={playlist.id}
                  className="size-14 rounded-sm lg:size-12"
                />
                <span className="flex min-w-0 grow flex-col gap-px">
                  <span className="truncate font-sans text-md/base text-text lg:text-base/sm lg:font-medium">
                    {playlist.name}
                  </span>
                  <span className="truncate font-sans text-sm/xs text-text-muted">
                    {playlist.owner?.name ?? "Someone"} ·{" "}
                    {playlist.access === "collaborator" ? "you can edit" : "view only"} ·{" "}
                    {plural(playlist.trackCount, "song")}
                  </span>
                </span>
                <ChevronRightIcon aria-hidden className="size-5 text-text-muted" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
