import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { createFileRoute } from "@tanstack/react-router";

import { CollectionCard } from "@/components/browse/collection-card";
import { PosterGridSkeleton } from "@/components/browse/skeletons";
import { GridHeader, PosterGrid } from "@/components/browse/title-grid-page";
import { describeFailure } from "@/lib/failure";
import { plural } from "@/lib/format";
import { useActiveProfile } from "@/session/guards";

export const Route = createFileRoute("/_app/collections")({
  head: () => ({ meta: [{ title: "Collections · [movies]" }] }),
  component: CollectionsPage,
});

function CollectionsPage() {
  const { profile } = useActiveProfile();
  const collections = useCommandQuery("collections.list", { profileId: profile.id });

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      <GridHeader
        title="Collections"
        count={
          collections.status === "success"
            ? plural(collections.data.length, "collection", "collections")
            : undefined
        }
      />
      {collections.status === "loading" ? (
        <PosterGridSkeleton />
      ) : collections.status === "error" ? (
        <CalmState
          className="py-24"
          title="Collections didn't load"
          description={describeFailure(collections.error)}
          actions={<Button onClick={collections.retry}>Try again</Button>}
        />
      ) : collections.data.length === 0 ? (
        <CalmState className="py-24" title="No collections yet" />
      ) : (
        <PosterGrid>
          {collections.data.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} className="w-full" />
          ))}
        </PosterGrid>
      )}
    </div>
  );
}
