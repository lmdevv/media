import type { ArtistCard as Artist } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { Skeleton } from "@music/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";

import { ArtistCircle, PageHeader } from "@/components/library/cards";
import { Paged } from "@/components/library/paged";
import type { PageResult } from "@/components/library/paged";
import { plural } from "@/lib/format";

export const Route = createFileRoute("/_app/artists/")({ component: ArtistsPage });

const PAGE_SIZE = 60;

const useArtistPage = (cursor: string | null, end: string | null): PageResult<Artist> | undefined =>
  useRead("artists.list", { cursor, end, limit: PAGE_SIZE });

const skeleton = Array.from({ length: 12 }, (_, index) => (
  <div key={`skeleton-${index}`} className="flex flex-col items-center gap-2.5">
    <Skeleton className="aspect-square w-full rounded-full" />
    <Skeleton className="h-2.5 w-[60%]" />
  </div>
));

function ArtistsPage() {
  const home = useRead("library.home", {});

  return (
    <div className="flex flex-col gap-7 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader
        eyebrow={home === undefined ? undefined : plural(home.stats.artists, "artist")}
        title="Artists"
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:gap-x-5 lg:gap-y-7 xl:grid-cols-6">
        <Paged
          usePage={useArtistPage}
          skeleton={skeleton}
          empty={
            <p className="col-span-full font-sans text-md/md text-text-muted">No artists yet.</p>
          }
          renderItem={(artist) => <ArtistCircle key={artist.id} artist={artist} />}
        />
      </div>
    </div>
  );
}
