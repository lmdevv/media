import { usePages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { Library } from "lucide-react-native";
import { ActivityIndicator, FlatList } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollectionCard } from "@/components/browse/collection-card";
import { EmptyState } from "@/components/browse/empty-state";
import { loadMoreOf, PagingFooter } from "@/components/browse/poster-grid";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";

export default function Collections() {
  return (
    <Screen edges={["top"]} header={<NavHeader title="Collections" />}>
      <CollectionsBody />
    </Screen>
  );
}

function CollectionsBody() {
  const platform = usePlatform();
  const insets = useSafeAreaInsets();

  const collections = usePages(platform.movies.collections.list, (paginationOpts) => ({
    paginationOpts,
  }));

  if (collections.status === "loading") {
    return <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />;
  }

  if (collections.status === "failed") {
    return (
      <CalmState
        title="Couldn't Load Collections"
        description={collections.message}
        actions={<Button label="Try Again" onPress={collections.retry} />}
      />
    );
  }

  return (
    <FlatList
      data={collections.rows}
      keyExtractor={(collection) => collection.id}
      renderItem={({ item }) => <CollectionCard collection={item} size="wide" />}
      ListEmptyComponent={
        collections.next.kind === "done" ? (
          <EmptyState icon={Library} title="No Collections Yet" />
        ) : undefined
      }
      ListFooterComponent={<PagingFooter pages={collections} />}
      onEndReached={loadMoreOf(collections)}
      onEndReachedThreshold={1}
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: insets.bottom }}
    />
  );
}
