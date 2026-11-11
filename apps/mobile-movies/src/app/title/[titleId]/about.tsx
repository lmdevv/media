import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import { titleIdParam } from "@/components/title/route-params";
import { CENTERED_COLUMN } from "@/components/ui/page-layout";
import { aboutRows } from "@/components/title/title-model";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Image } from "@/components/ui/image";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import type { TitleDetail } from "@/lib/catalog";
import { describeFailure, isFailure } from "@/lib/failure";
import { useServer } from "@/session/connection";

function About({ title }: { readonly title: TitleDetail }) {
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");

  return (
    <>
      <View className="aspect-video w-full overflow-hidden rounded-card bg-surface-raised">
        {backdrop === undefined ? null : (
          <Image source={{ uri: backdrop }} contentFit="cover" className="size-full" />
        )}
      </View>
      <Text variant="title" accessibilityRole="header">
        {title.name}
      </Text>
      {title.tagline === null ? null : (
        <Text variant="bodyStrong" tone="muted">
          {title.tagline}
        </Text>
      )}
      {title.overview === null ? null : <Text>{title.overview}</Text>}
      {aboutRows(title).map((row) => (
        <View
          key={row.label}
          accessible
          accessibilityLabel={`${row.label}, ${row.value}`}
          className="min-h-14 flex-row items-center gap-4"
        >
          <Text>{row.label}</Text>
          <Text variant="secondary" tone="muted" className="flex-1 text-right">
            {row.value}
          </Text>
        </View>
      ))}
    </>
  );
}

export default function AboutTitle() {
  const params = useLocalSearchParams<{ titleId: string }>();
  const platform = usePlatform();
  const titleId = titleIdParam(params.titleId);

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(titleId === null ? (["skip"] as const) : [{ titleId }]),
  );

  const heading =
    title.status !== "success"
      ? "About"
      : title.data.kind === "show"
        ? "About This Show"
        : "About This Movie";

  if (titleId === null) {
    return (
      <Screen header={<NavHeader title="About" />}>
        <CalmState icon={CircleAlert} title="Title Not Found" />
      </Screen>
    );
  }

  if (title.status === "error") {
    const missing = isFailure(title.error, "NotFound");

    return (
      <Screen header={<NavHeader title="About" />}>
        <CalmState
          icon={CircleAlert}
          title={missing ? "Title Not Found" : "Couldn't Load This Title"}
          {...(missing
            ? {}
            : {
                description: describeFailure(title.error),
                actions: <Button label="Try Again" onPress={title.retry} />,
              })}
        />
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      edges={["top"]}
      header={<NavHeader title={heading} />}
      contentClassName={`pb-12 ${CENTERED_COLUMN}`}
    >
      {title.status === "loading" ? (
        <ActivityIndicator className="py-12" colorClassName="accent-text-muted" />
      ) : (
        <About title={title.data} />
      )}
    </Screen>
  );
}
