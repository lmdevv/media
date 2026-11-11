import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { useAllPages } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { PosterGridSkeleton } from "@/components/browse/skeletons";
import { TitlePosterCard } from "@/components/browse/title-cards";
import { GridHeader, PosterGrid } from "@/components/browse/title-grid-page";
import { plural, titleFacts } from "@/lib/format";

export const Route = createFileRoute("/_app/my-list")({
  head: () => ({ meta: [{ title: "My List · [movies]" }] }),
  component: MyListPage,
});

function MyListPage() {
  const platform = usePlatform();
  const list = useAllPages(platform.movies.myList.list, (paginationOpts) => ({ paginationOpts }));
  const complete = list.status === "ready" && list.next.kind === "done";

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      <GridHeader
        title="My List"
        count={complete ? plural(list.rows.length, "title", "titles") : undefined}
      />
      {list.status === "loading" ? (
        <PosterGridSkeleton />
      ) : list.status === "failed" ? (
        <CalmState
          className="py-24"
          title="My List didn't load"
          description={list.message}
          actions={<Button onClick={list.retry}>Try again</Button>}
        />
      ) : list.rows.length === 0 && complete ? (
        <CalmState className="py-24" title="Nothing on your list yet" />
      ) : (
        <PosterGrid>
          {list.rows.map((title) => (
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
