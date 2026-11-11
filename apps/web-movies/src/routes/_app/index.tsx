import type { Home, TitleCard } from "@/lib/catalog";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useFirstRows } from "@media/ui/lib/pages";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { MediaRow } from "@media/ui/components/media-row";
import { Link, createFileRoute } from "@tanstack/react-router";

import { CollectionCard } from "@/components/browse/collection-card";
import { HomeHero } from "@/components/browse/home-hero";
import { EmptyLibrary, NothingToWatch, ScanningLibrary } from "@/components/browse/library-states";
import { HeroSkeleton, RowSkeleton } from "@/components/browse/skeletons";
import { newBadge } from "@/components/browse/new-badge";
import { ContinueCard, TitleLandscapeCard, TitlePosterCard } from "@/components/browse/title-cards";
import { describeFailure } from "@media/ui/lib/failure";
import { useActiveScans, useMovieLibraries } from "@/lib/libraries";
import { useMe, useScopes } from "@/session/session";
import { usePhone } from "@/lib/use-phone";

export const Route = createFileRoute("/_app/")({
  staticData: { hero: true },
  component: HomePage,
});

const ROW_COLLECTIONS = 20;

const NO_LIBRARIES: ReadonlyArray<never> = [];

const SCANNING_UNTIL = 8;

const newestFirst = (titles: ReadonlyArray<TitleCard>): ReadonlyArray<TitleCard> =>
  titles.toSorted((a, b) => b.addedAt - a.addedAt);

function HomePage() {
  const platform = usePlatform();
  const scopes = useScopes();
  const home = usePlatformQuery(platform.movies.titles.home);
  const libraries = useMovieLibraries();
  const scans = useActiveScans(libraries.status === "ready" ? libraries.rows : NO_LIBRARIES);

  if (home.status === "loading" || libraries.status === "loading") return <HomeSkeleton />;

  if (home.status === "error" || libraries.status === "failed") {
    const retry = (): void => {
      if (home.status === "error") home.retry();

      if (libraries.status === "failed") libraries.retry();
    };

    return (
      <div className="flex min-h-[60svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title="Home didn't load"
          description={
            home.status === "error"
              ? describeFailure(home.error)
              : libraries.status === "failed"
                ? libraries.message
                : undefined
          }
          actions={<Button onClick={retry}>Try again</Button>}
        />
      </div>
    );
  }

  if (libraries.rows.length === 0) {
    return (
      <div className="md:pt-17">
        <EmptyLibrary canAdd={scopes.has("admin")} />
      </div>
    );
  }

  const arrived = newestFirst([...home.data.recentlyAddedMovies, ...home.data.recentlyAddedShows]);
  const scanning = scans.length > 0;

  if (scanning && (home.data.featured === null || arrived.length < SCANNING_UNTIL)) {
    return <ScanningLibrary arrived={arrived} />;
  }

  if (home.data.featured === null && arrived.length === 0 && home.data.myList.length === 0) {
    return (
      <div className="md:pt-17">
        <NothingToWatch />
      </div>
    );
  }

  return <HomeRows home={home.data} />;
}

function HomeSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-11">
      <HeroSkeleton />
      <RowSkeleton kind="landscape" />
      <RowSkeleton kind="poster" />
    </div>
  );
}

function HomeRows({ home }: { readonly home: Home }) {
  const me = useMe();
  const phone = usePhone();
  const now = Date.now();
  const size = phone ? "phone" : "desktop";

  const titleRow = (titles: ReadonlyArray<TitleCard>) =>
    titles.map((title) =>
      phone ? (
        <TitleLandscapeCard key={title.id} title={title} size="phone" />
      ) : (
        <TitlePosterCard key={title.id} title={title} badge={newBadge(title, now)} />
      ),
    );

  return (
    <div className="flex flex-col">
      {home.featured === null ? (
        <div className="md:h-17" />
      ) : (
        <HomeHero featured={home.featured} phone={phone} />
      )}
      <div className="flex flex-col pt-1 md:gap-11">
        {home.continueWatching.length === 0 ? null : (
          <MediaRow
            title={
              phone || me === null ? "Continue watching" : `Continue watching for ${me.username}`
            }
          >
            {home.continueWatching.map((item) => (
              <ContinueCard
                key={`${item.title.id}:${item.episode?.id ?? ""}`}
                item={item}
                size={size}
              />
            ))}
          </MediaRow>
        )}
        {home.recentlyAddedMovies.length === 0 ? null : (
          <MediaRow title="Recently added" seeAll={<Link to="/movies" />}>
            {titleRow(home.recentlyAddedMovies)}
          </MediaRow>
        )}
        {home.recentlyAddedShows.length === 0 ? null : (
          <MediaRow title="Shows" seeAll={<Link to="/shows" />}>
            {titleRow(home.recentlyAddedShows)}
          </MediaRow>
        )}
        {home.myList.length === 0 ? null : (
          <MediaRow title="My List" seeAll={<Link to="/my-list" />}>
            {titleRow(home.myList)}
          </MediaRow>
        )}
        <CollectionsRow />
      </div>
    </div>
  );
}

function CollectionsRow() {
  const platform = usePlatform();

  const collections = useFirstRows(
    platform.movies.collections.list,
    (paginationOpts) => ({ paginationOpts }),
    ROW_COLLECTIONS,
  );

  if (collections.status !== "ready" || collections.rows.length === 0) return null;

  return (
    <MediaRow title="Collections" seeAll={<Link to="/collections" />}>
      {collections.rows.slice(0, ROW_COLLECTIONS).map((collection) => (
        <CollectionCard key={collection.id} collection={collection} />
      ))}
    </MediaRow>
  );
}
