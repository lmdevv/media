import { useCommandQuery } from "@media/sdk/react";
import { Library } from "lucide-react-native";
import { ActivityIndicator, FlatList } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollectionCard } from "@/components/browse/collection-card";
import { EmptyState } from "@/components/browse/empty-state";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

export default function Collections() {
  return (
    <Screen edges={["top"]} header={<NavHeader title="Collections" />}>
      <CollectionsBody />
    </Screen>
  );
}

function CollectionsBody() {
  const { profile } = useActiveProfile();
  const insets = useSafeAreaInsets();
  const collections = useCommandQuery("collections.list", { profileId: profile.id });

  if (collections.status === "loading") {
    return <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />;
  }

  if (collections.status === "error") {
    return (
      <CalmState
        title="Couldn't Load Collections"
        description={describeFailure(collections.error)}
        actions={<Button label="Try Again" onPress={collections.retry} />}
      />
    );
  }

  return (
    <FlatList
      data={collections.data}
      keyExtractor={(collection) => collection.id}
      renderItem={({ item }) => <CollectionCard collection={item} size="wide" />}
      ListEmptyComponent={<EmptyState icon={Library} title="No Collections Yet" />}
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: insets.bottom }}
    />
  );
}
