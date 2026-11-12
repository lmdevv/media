import { describeFailure } from "@media/mobile-core/failure";
import { useFirstRows } from "@media/mobile-core/pages";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Folder, Plus, Popcorn } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollectionCard } from "@/components/browse/collection-card";
import { EmptyState } from "@/components/browse/empty-state";
import { Hero } from "@/components/browse/hero";
import { TAB_BAR_CLEARANCE } from "@/components/browse/layout";
import { useActiveScans, useMovieLibraries } from "@/components/browse/libraries";
import type { ActiveScan, Library } from "@/components/browse/libraries";
import { ProfileButton } from "@/components/browse/profile-button";
import { Rail } from "@/components/browse/rail";
import { ScanStatus } from "@/components/browse/scan-status";
import { CompactBar, LargeTitle, useCollapse } from "@/components/browse/tab-chrome";
import { ContinueCard } from "@/components/continue-card";
import { TitlePoster } from "@/components/title-poster";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { homeScreen } from "@/lib/browse";
import type { HomeScreen } from "@/lib/browse";
import type { Home as HomeRows } from "@/lib/catalog";
import { useWidthClass } from "@/lib/use-width-class";
import { useMe } from "@/session/me";

const STICKY_BAR = [0];

const NO_LIBRARIES: ReadonlyArray<Library> = [];

const ROW_COLLECTIONS = 20;

export default function Home() {
  const platform = usePlatform();
  const home = usePlatformQuery(platform.movies.titles.home);
  const libraries = useMovieLibraries();
  const scans = useActiveScans(libraries.status === "ready" ? libraries.rows : NO_LIBRARIES);
  const collapse = useCollapse();
  const insets = useSafeAreaInsets();
  const clearance = TAB_BAR_CLEARANCE[useWidthClass()];
  const [barHeight, setBarHeight] = useState(0);

  const loaded =
    home.status === "success" && libraries.status === "ready"
      ? {
          rows: home.data,
          screen: homeScreen(home.data, {
            count: libraries.rows.length,
            scanning: scans.length > 0,
          }),
        }
      : null;

  const failure =
    home.status === "error"
      ? describeFailure(home.error)
      : libraries.status === "failed"
        ? libraries.message
        : null;

  // The scroll view is the page itself, from the first render on: UIKit looks for it there as the
  // tab appears, to minimize the tab bar as it scrolls and soften the content behind it (C02).
  return (
    <ScrollView
      onScroll={collapse.onScroll}
      scrollEventThrottle={16}
      contentInsetAdjustmentBehavior="never"
      stickyHeaderIndices={STICKY_BAR}
      className="flex-1 bg-bg"
      contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + clearance }}
    >
      <CompactBar
        title="Home"
        collapsed={collapse.collapsed}
        trailing={
          <ProfileButton overMedia={loaded?.screen.fullBleed === true && !collapse.collapsed} />
        }
        onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
      />
      <View className="flex-1" style={{ marginTop: -barHeight }}>
        {failure !== null ? (
          <View className="flex-1" style={{ paddingTop: insets.top }}>
            <CalmState
              title="Couldn't Load Home"
              description={failure}
              actions={
                <Button
                  label="Try Again"
                  onPress={() => {
                    if (home.status === "error") home.retry();

                    if (libraries.status === "failed") libraries.retry();
                  }}
                />
              }
            />
          </View>
        ) : loaded === null ? null : (
          <>
            {loaded.screen.fullBleed ? (
              <Hero titles={loaded.screen.pages} header={<LargeTitle title="Home" overMedia />} />
            ) : (
              <LargeTitle title="Home" />
            )}
            <HomeBody screen={loaded.screen} home={loaded.rows} scans={scans} />
          </>
        )}
      </View>
    </ScrollView>
  );
}

function AddLibrary() {
  const me = useMe();

  if (!me.scopes.includes("admin")) return null;

  return (
    <Button label="Add a Library" icon={Plus} onPress={() => router.push("/owner/libraries/new")} />
  );
}

function HomeBody({
  screen: { layout, arrived },
  home,
  scans,
}: {
  readonly screen: HomeScreen;
  readonly home: HomeRows;
  readonly scans: ReadonlyArray<ActiveScan>;
}) {
  if (layout === "empty") {
    return <EmptyState icon={Folder} title="Your library is empty." action={<AddLibrary />} />;
  }

  if (layout === "nothing") return <EmptyState icon={Popcorn} title="Nothing to Watch Yet" />;

  if (layout === "scanning") {
    return (
      <View className="gap-8 pt-4 regular:gap-10 regular:pt-2 regular:pb-16">
        <ScanStatus scans={scans} />
        <Rail
          title="Recently Added"
          items={arrived}
          keyOf={(title) => title.id}
          render={(title) => <TitlePoster title={title} />}
        />
      </View>
    );
  }

  return (
    <View className="gap-8 pt-4 regular:gap-10 regular:pt-2 regular:pb-16">
      <Rail
        title="Continue Watching"
        items={home.continueWatching}
        keyOf={(item) => `${item.title.id}:${item.episode?.id ?? ""}`}
        render={(item) => <ContinueCard item={item} />}
      />
      <Rail
        title="Recently Added"
        items={arrived}
        keyOf={(title) => title.id}
        render={(title) => <TitlePoster title={title} />}
      />
      <Rail
        title="My List"
        items={home.myList}
        keyOf={(title) => title.id}
        render={(title) => <TitlePoster title={title} artwork="still" />}
      />
      <CollectionsRow />
    </View>
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
    <Rail
      title="Collections"
      items={collections.rows.slice(0, ROW_COLLECTIONS)}
      keyOf={(collection) => collection.id}
      render={(collection) => <CollectionCard collection={collection} size="rail" />}
      onSeeAll={() => router.push("/collections")}
    />
  );
}
