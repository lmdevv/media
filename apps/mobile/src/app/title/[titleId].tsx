import type { ProfileId, TitleId } from "@media/contracts/ids";
import type { SeasonEpisode, TitleDetail } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronDown, CircleAlert } from "lucide-react-native";
import { ActivityIndicator, Pressable, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { WatchTogetherRow } from "@/components/rooms/watch-together-row";
import { EpisodeCard } from "@/components/title/episode-card";
import { EpisodeRow } from "@/components/title/episode-row";
import { FileUnavailable } from "@/components/title/file-unavailable";
import { seasonParam, titleIdParam } from "@/components/title/route-params";
import { GUTTER, READABLE_COLUMN } from "@/components/ui/page-layout";
import { TitleHero, TitleTopBar } from "@/components/title/title-hero";
import { initialSeason } from "@/components/title/title-model";
import {
  AboutRow,
  AvailableVersions,
  CastAndCrew,
  MoreLikeThis,
} from "@/components/title/title-sections";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure, isFailure } from "@/lib/failure";
import { episodeLayout, heroHeight, rowsOf, topBarFade } from "@/lib/title-layout";
import { useWidthClass } from "@/lib/use-width-class";
import { useActiveProfile } from "@/session/active-profile";

const NO_EPISODES: ReadonlyArray<SeasonEpisode> = [];

function SeasonHeading({
  title,
  seasonNumber,
}: {
  readonly title: TitleDetail;
  readonly seasonNumber: number;
}) {
  const season = title.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);
  const name = season?.name ?? `Season ${seasonNumber}`;

  if (title.seasons.length < 2) {
    return (
      <Text variant="heading" className={GUTTER} accessibilityRole="header">
        {name}
      </Text>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, choose season`}
      onPress={() => router.push(`/title/${title.id}/seasons?season=${seasonNumber}`)}
      className={`flex-row items-center gap-2 self-start active:opacity-60 ${GUTTER}`}
    >
      <Text variant="heading">{name}</Text>
      <Icon icon={ChevronDown} size="inline" />
    </Pressable>
  );
}

function TitleDetailView({
  title,
  profileId,
}: {
  readonly title: TitleDetail;
  readonly profileId: ProfileId;
}) {
  const params = useLocalSearchParams<{ season?: string }>();
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const seasonNumber = seasonParam(params.season) ?? initialSeason(title);
  const show = title.kind === "show";
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const widthClass = useWidthClass();
  const phone = widthClass === "compact";
  const hero = heroHeight(windowHeight, widthClass);
  const layout = episodeLayout(widthClass);
  const openActions = () => router.push(`/title/${title.id}/actions`);

  const episodes = useCommandQuery(
    "titles.episodes",
    show && seasonNumber !== null ? { profileId, titleId: title.id, seasonNumber } : "skip",
  );

  return (
    <View className="flex-1 bg-bg">
      <Animated.FlatList
        data={rowsOf(
          episodes.status === "success" ? episodes.data : NO_EPISODES,
          layout.kind === "grid" ? layout.columns : 1,
        )}
        keyExtractor={(row) => row.map((episode) => episode.id).join(" ")}
        renderItem={({ item }) =>
          layout.kind === "grid" ? (
            <View className={`flex-row gap-4 ${GUTTER}`}>
              {item.map((episode) => (
                <EpisodeCard key={episode.id} episode={episode} />
              ))}
              {Array.from({ length: layout.columns - item.length }, (_, index) => (
                <View key={`blank-${index}`} className="flex-1" />
              ))}
            </View>
          ) : (
            <>
              {item.map((episode) => (
                <EpisodeRow key={episode.id} episode={episode} />
              ))}
            </>
          )
        }
        ItemSeparatorComponent={EpisodeGap}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerClassName="pb-16"
        ListHeaderComponent={
          <View className="gap-4 pb-4">
            <TitleHero
              title={title}
              profileId={profileId}
              scrollY={scrollY}
              widthClass={widthClass}
              height={hero}
              onMore={openActions}
            />
            {phone ? (
              <View className="gap-3 px-5">
                <WatchTogetherRow titleId={title.id} />
                {show ? null : <AboutRow title={title} />}
              </View>
            ) : null}
            {show && seasonNumber !== null ? (
              <SeasonHeading title={title} seasonNumber={seasonNumber} />
            ) : null}
            {show && seasonNumber !== null && episodes.status === "loading" ? (
              <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
            ) : null}
            {episodes.status === "error" ? (
              <View className={`items-start gap-2 ${GUTTER}`}>
                <Text variant="meta" tone="danger">
                  {describeFailure(episodes.error)}
                </Text>
                <Button label="Try Again" variant="secondary" onPress={episodes.retry} />
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <View className={`gap-6 pt-2 regular:gap-10 ${show ? "regular:pt-10" : "regular:pt-0"}`}>
            <View className={`gap-6 regular:gap-8 ${READABLE_COLUMN}`}>
              {phone ? (
                show ? (
                  <AboutRow title={title} />
                ) : null
              ) : (
                <View>
                  <WatchTogetherRow titleId={title.id} />
                  <AboutRow title={title} />
                </View>
              )}
              <CastAndCrew title={title} />
              <AvailableVersions title={title} />
            </View>
            <MoreLikeThis profileId={profileId} titleId={title.id} />
          </View>
        }
      />
      <TitleTopBar
        name={title.name}
        scrollY={scrollY}
        fade={topBarFade(hero, insets.top, widthClass)}
        moreInHero={!phone}
        onMore={openActions}
      />
    </View>
  );
}

function EpisodeGap() {
  return <View className="h-4 regular:h-8" />;
}

function TitleLoader({ titleId }: { readonly titleId: TitleId }) {
  const { profile } = useActiveProfile();
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId });

  if (title.status === "loading") {
    return (
      <Screen edges={["top"]} header={<NavHeader />}>
        <ActivityIndicator className="flex-1" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (title.status === "error") {
    const missing = isFailure(title.error, "NotFound");

    return (
      <Screen header={<NavHeader />}>
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

  return title.data.available ? (
    <TitleDetailView title={title.data} profileId={profile.id} />
  ) : (
    <FileUnavailable title={title.data} />
  );
}

export default function TitleScreen() {
  const params = useLocalSearchParams<{ titleId: string }>();
  const titleId = titleIdParam(params.titleId);

  if (titleId === null) {
    return (
      <Screen header={<NavHeader />}>
        <CalmState icon={CircleAlert} title="Title Not Found" />
      </Screen>
    );
  }

  return <TitleLoader key={titleId} titleId={titleId} />;
}
