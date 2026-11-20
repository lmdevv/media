import { Skeleton } from "@/components/ui/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AlbumCard, PageHeader } from "@/components/library/cards";
import { Paged } from "@/components/library/paged";
import { plural } from "@/lib/format";
import { preloadFirstPage, usePages } from "@media/ui/lib/pages";
import type { PageOpts } from "@media/ui/lib/pages";
import { useMusic, useRead } from "@/lib/platform";

const PAGE_SIZE = 48;

/** The arguments of each page of albums, shared by the loader and the page. */
const albumsPage = (paginationOpts: PageOpts) => ({ paginationOpts });

export const Route = createFileRoute("/_app/albums/")({
  loader: async ({ context: { platform } }) => {
    // The header's counts, started with the list so they arrive with it.
    void platform.music.library.home.preload({});
    await preloadFirstPage(platform.music.albums.list, albumsPage, PAGE_SIZE);
  },
  pendingComponent: AlbumsSkeleton,
  component: AlbumsPage,
});

const skeleton = Array.from({ length: 12 }, (_, index) => (
  <div key={`skeleton-${index}`} className="flex flex-col gap-2.5">
    <Skeleton className="aspect-square w-full rounded-md" />
    <Skeleton className="h-2.5 w-[70%]" />
    <Skeleton className="h-2.5 w-[45%]" />
  </div>
));

/** The albums screen around its grid: the header, with the album count once it loads. */
function AlbumsFrame({
  eyebrow,
  children,
}: {
  readonly eyebrow: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-7 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader
        eyebrow={eyebrow}
        title="Albums"
        actions={
          <span className="hidden font-sans text-sm/xs font-medium text-text-muted lg:block">
            Recently added
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:gap-x-5 lg:gap-y-7 xl:grid-cols-6">
        {children}
      </div>
    </div>
  );
}

function AlbumsSkeleton() {
  return <AlbumsFrame eyebrow={null}>{skeleton}</AlbumsFrame>;
}

function AlbumsPage() {
  const music = useMusic();
  const home = useRead(music.library.home, {});
  const paged = usePages(music.albums.list, albumsPage, PAGE_SIZE);

  return (
    <AlbumsFrame eyebrow={home === undefined ? null : plural(home.stats.albums, "album")}>
      <Paged
        paged={paged}
        skeleton={skeleton}
        empty={
          <p className="col-span-full font-sans text-md/md text-text-muted">
            No albums yet. They appear here as your library is scanned.
          </p>
        }
        renderItem={(album) => <AlbumCard key={album.id} album={album} />}
      />
    </AlbumsFrame>
  );
}
