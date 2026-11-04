import type { ProfileId } from "@media/contracts/ids";
import type { Home, TitleCard } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
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
import { describeFailure } from "@/lib/failure";
import { usePhone } from "@/lib/use-phone";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

export const Route = createFileRoute("/_app/")({
  staticData: { hero: true },
  component: HomePage,
});

const ROW_COLLECTIONS = 20;

const SCANNING_UNTIL = 8;

const newestFirst = (titles: ReadonlyArray<TitleCard>): ReadonlyArray<TitleCard> =>
  titles.toSorted((a, b) => b.addedAt - a.addedAt);

function HomePage() {
  const { profile } = useActiveProfile();
  const scopes = useScopes();
  const home = useCommandQuery("titles.home", { profileId: profile.id });
  const libraries = useCommandQuery("libraries.list", {});

  if (home.status === "loading" || libraries.status === "loading") return <HomeSkeleton />;

  if (home.status === "error" || libraries.status === "error") {
    const failed = [home, libraries].filter((query) => query.status === "error");

    return (
      <div className="flex min-h-[60svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title="Home didn't load"
          description={describeFailure(failed[0]?.error)}
          actions={
            <Button
              onClick={() => {
                for (const query of failed) query.retry();
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (libraries.data.length === 0) {
    return (
      <div className="md:pt-17">
        <EmptyLibrary canManage={scopes.has("manage")} />
      </div>
    );
  }

  const arrived = newestFirst([...home.data.recentlyAddedMovies, ...home.data.recentlyAddedShows]);
  const scanning = libraries.data.some((library) => library.scanning);

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
  const { profile } = useActiveProfile();
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
        <HomeHero featured={home.featured} profileId={profile.id} phone={phone} />
      )}
      <div className="flex flex-col pt-1 md:gap-11">
        {home.continueWatching.length === 0 ? null : (
          <MediaRow title={phone ? "Continue watching" : `Continue watching for ${profile.name}`}>
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
        <CollectionsRow profileId={profile.id} />
      </div>
    </div>
  );
}

function CollectionsRow({ profileId }: { readonly profileId: ProfileId }) {
  const collections = useCommandQuery("collections.list", { profileId, limit: ROW_COLLECTIONS });

  if (collections.status !== "success" || collections.data.length === 0) return null;

  return (
    <MediaRow title="Collections" seeAll={<Link to="/collections" />}>
      {collections.data.map((collection) => (
        <CollectionCard key={collection.id} collection={collection} />
      ))}
    </MediaRow>
  );
}
