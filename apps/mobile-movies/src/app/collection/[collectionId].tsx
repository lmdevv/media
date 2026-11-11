import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Play } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import { PosterGrid } from "@/components/browse/poster-grid";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { titleCount } from "@/lib/browse";
import { asCollectionId } from "@/lib/catalog";
import type { CollectionId } from "@/lib/catalog";
import { watchHref } from "@/lib/routes";
import { describeFailure, isFailure } from "@/lib/failure";

export default function CollectionPage() {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();

  return (
    <>
      {collectionId !== "" ? (
        <CollectionScreen collectionId={asCollectionId(collectionId)} />
      ) : (
        <Screen header={<NavHeader />}>
          <CalmState title="This Collection Isn't Here" />
        </Screen>
      )}
      <UndoBar />
    </>
  );
}

function CollectionScreen({ collectionId }: { readonly collectionId: CollectionId }) {
  const platform = usePlatform();
  const collection = usePlatformQuery(platform.movies.collections.get, { collectionId });

  if (collection.status === "loading") {
    return (
      <Screen edges={["top"]} header={<NavHeader />}>
        <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (collection.status === "error") {
    const missing = isFailure(collection.error, "NotFound");

    return (
      <Screen header={<NavHeader />}>
        {missing ? (
          <CalmState title="This Collection Isn't Here" />
        ) : (
          <CalmState
            title="Couldn't Load This Collection"
            description={describeFailure(collection.error)}
            actions={<Button label="Try Again" onPress={collection.retry} />}
          />
        )}
      </Screen>
    );
  }

  const { data } = collection;
  const first = data.titles.find((title) => title.available);

  return (
    <Screen edges={["top"]} header={<NavHeader title={data.name} />}>
      <PosterGrid
        titles={data.titles}
        header={
          <View className="gap-4 px-5 pt-4 pb-1 regular:px-8 wide:px-12">
            <Text variant="secondary" tone="muted">
              {titleCount(data.titles)}
            </Text>
            {first === undefined ? null : (
              <Button
                label={`Play ${first.name}`}
                icon={Play}
                iconFilled
                onPress={() => router.push(watchHref({ titleId: first.id }))}
              />
            )}
          </View>
        }
      />
    </Screen>
  );
}
