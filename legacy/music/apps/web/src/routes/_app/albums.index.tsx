import type { AlbumCard as Album } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";

import { AlbumCard, PageHeader } from "@/components/library/cards";
import { Paged } from "@/components/library/paged";
import type { PageResult } from "@/components/library/page-chain";
import { plural } from "@/lib/format";

export const Route = createFileRoute("/_app/albums/")({ component: AlbumsPage });

const PAGE_SIZE = 48;

const useAlbumPage = (cursor: string | null, end: string | null): PageResult<Album> | undefined =>
  useRead("albums.list", { cursor, end, limit: PAGE_SIZE });

const skeleton = Array.from({ length: 12 }, (_, index) => (
  <div key={`skeleton-${index}`} className="flex flex-col gap-2.5">
    <Skeleton className="aspect-square w-full rounded-md" />
    <Skeleton className="h-2.5 w-[70%]" />
    <Skeleton className="h-2.5 w-[45%]" />
  </div>
));

function AlbumsPage() {
  const home = useRead("library.home", {});

  return (
    <div className="flex flex-col gap-7 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader
        eyebrow={home === undefined ? null : plural(home.stats.albums, "album")}
        title="Albums"
        actions={
          <span className="hidden font-sans text-sm/xs font-medium text-text-muted lg:block">
            Recently added
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:gap-x-5 lg:gap-y-7 xl:grid-cols-6">
        <Paged
          usePage={useAlbumPage}
          skeleton={skeleton}
          empty={
            <p className="col-span-full font-sans text-md/md text-text-muted">
              No albums yet. They appear here as your library is scanned.
            </p>
          }
          renderItem={(album) => <AlbumCard key={album.id} album={album} />}
        />
      </div>
    </div>
  );
}
