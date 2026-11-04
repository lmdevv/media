import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { createFileRoute } from "@tanstack/react-router";

import { PosterGridSkeleton } from "@/components/browse/skeletons";
import { TitlePosterCard } from "@/components/browse/title-cards";
import { GridHeader, PosterGrid } from "@/components/browse/title-grid-page";
import { describeFailure } from "@/lib/failure";
import { plural, titleFacts } from "@/lib/format";
import { useActiveProfile } from "@/session/guards";

export const Route = createFileRoute("/_app/my-list")({
  head: () => ({ meta: [{ title: "My List · [movies]" }] }),
  component: MyListPage,
});

function MyListPage() {
  const { profile } = useActiveProfile();
  const list = useCommandQuery("myList.list", { profileId: profile.id });

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      <GridHeader
        title="My List"
        count={list.status === "success" ? plural(list.data.length, "title", "titles") : undefined}
      />
      {list.status === "loading" ? (
        <PosterGridSkeleton />
      ) : list.status === "error" ? (
        <CalmState
          className="py-24"
          title="My List didn't load"
          description={describeFailure(list.error)}
          actions={<Button onClick={list.retry}>Try again</Button>}
        />
      ) : list.data.length === 0 ? (
        <CalmState className="py-24" title="Nothing on your list yet" />
      ) : (
        <PosterGrid>
          {list.data.map((title) => (
            <TitlePosterCard
              key={title.id}
              title={title}
              subtitle={titleFacts(title) || undefined}
              className="w-full"
            />
          ))}
        </PosterGrid>
      )}
    </div>
  );
}
