import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { PosterGrid } from "@/components/browse/poster-grid";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Image } from "@/components/ui/image";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { creditedTitles } from "@/lib/browse";
import { asPersonId } from "@/lib/catalog";
import type { PersonId } from "@/lib/catalog";
import { describeFailure, isFailure } from "@/lib/failure";
import { useServer } from "@/session/connection";

export default function PersonPage() {
  const { personId } = useLocalSearchParams<{ personId: string }>();

  return (
    <>
      {personId !== "" ? (
        <PersonScreen personId={asPersonId(personId)} />
      ) : (
        <Screen header={<NavHeader />}>
          <CalmState title="This Person Isn't Here" />
        </Screen>
      )}
      <UndoBar />
    </>
  );
}

function PersonScreen({ personId }: { readonly personId: PersonId }) {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const person = usePlatformQuery(platform.movies.people.get, { personId });
  const { requestDetails } = platform.movies.people;
  const pending = person.status === "success" && person.data.detailsPending;

  const [detailsFailure, setDetailsFailure] = useState<{ readonly cause: unknown } | null>(null);
  const [detailsAttempt, setDetailsAttempt] = useState(0);

  useEffect(() => {
    if (!pending) return;

    requestDetails({ personId }).catch((cause: unknown) => {
      setDetailsFailure({ cause });
    });
  }, [pending, personId, requestDetails, detailsAttempt]);

  if (person.status === "loading") {
    return (
      <Screen edges={["top"]} header={<NavHeader />}>
        <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (person.status === "error") {
    return (
      <Screen header={<NavHeader />}>
        {isFailure(person.error, "NotFound") ? (
          <CalmState title="This Person Isn't Here" />
        ) : (
          <CalmState
            title="Couldn't Load This Person"
            description={describeFailure(person.error)}
            actions={<Button label="Try Again" onPress={person.retry} />}
          />
        )}
      </Screen>
    );
  }

  const { data } = person;
  const photo = artworkUrl(mediaUrl, data.profile, "poster");
  const titles = creditedTitles(data.credits);

  return (
    <Screen edges={["top"]} header={<NavHeader title={data.name} />}>
      <PosterGrid
        titles={titles}
        header={
          <View className="gap-4 px-5 pt-4 pb-1 regular:px-8 wide:px-12">
            <View className="items-center">
              <View className="size-40 items-center justify-center overflow-hidden rounded-pill bg-surface-raised">
                {photo === undefined ? (
                  <Text variant="hero" tone="muted">
                    {data.name.trim().charAt(0).toUpperCase()}
                  </Text>
                ) : (
                  <Image
                    source={{ uri: photo }}
                    contentFit="cover"
                    transition={150}
                    className="size-full"
                    accessibilityLabel={data.name}
                  />
                )}
              </View>
            </View>
            {data.knownFor === null ? null : (
              <Text variant="secondary" tone="muted" className="text-center">
                {data.knownFor}
              </Text>
            )}
            {detailsFailure === null ? null : (
              <View className="items-center gap-2">
                <Text variant="meta" tone="danger" className="text-center">
                  {describeFailure(detailsFailure.cause)}
                </Text>
                <Button
                  label="Try Again"
                  variant="plain"
                  onPress={() => {
                    setDetailsFailure(null);
                    setDetailsAttempt((attempt) => attempt + 1);
                  }}
                />
              </View>
            )}
            {titles.length === 0 ? null : (
              <Text variant="heading" accessibilityRole="header">
                In Your Library
              </Text>
            )}
          </View>
        }
      />
    </Screen>
  );
}
