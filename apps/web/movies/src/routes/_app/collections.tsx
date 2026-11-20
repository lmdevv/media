import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { preloadFirstPage, useAllPages } from "@media/ui/lib/pages";
import type { PageOpts } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { CollectionCard } from "@/components/browse/collection-card";
import { PosterGridSkeleton } from "@/components/browse/skeletons";
import { GridHeader, GridPageSkeleton, PosterGrid } from "@/components/browse/title-grid-page";
import { plural } from "@/lib/format";

/** The arguments of each page of the collections, shared by the loader and the page. */
const collectionsPage = (paginationOpts: PageOpts) => ({ paginationOpts });

export const Route = createFileRoute("/_app/collections")({
  head: () => ({ meta: [{ title: "Collections · Lar Movies" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.movies.collections.list, collectionsPage),
  pendingComponent: () => <GridPageSkeleton heading="Collections" />,
  component: CollectionsPage,
});

function CollectionsPage() {
  const platform = usePlatform();
  const collections = useAllPages(platform.movies.collections.list, collectionsPage);

  const complete = collections.status === "ready" && collections.next.kind === "done";

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      <GridHeader
        title="Collections"
        count={complete ? plural(collections.rows.length, "collection", "collections") : undefined}
      />
      {collections.status === "loading" ? (
        <PosterGridSkeleton />
      ) : collections.status === "failed" ? (
        <CalmState
          className="py-24"
          title="Collections didn't load"
          description={collections.message}
          actions={<Button onClick={collections.retry}>Try again</Button>}
        />
      ) : collections.rows.length === 0 && complete ? (
        <CalmState className="py-24" title="No collections yet" />
      ) : (
        <PosterGrid>
          {collections.rows.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} className="w-full" />
          ))}
        </PosterGrid>
      )}
    </div>
  );
}
