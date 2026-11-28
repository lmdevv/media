import { allOfSeason, seasonPageArgs } from "@media/contracts/opening-season";
import { describeFailure, isFailure } from "@media/mobile-core/failure";
import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react-native";
import { Pressable, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EpisodeCard } from "@/components/title/episode-card";
import { EpisodeRow } from "@/components/title/episode-row";
import { FileUnavailable } from "@/components/title/file-unavailable";
import { seasonParam, titleIdParam } from "@/components/title/route-params";
import { GUTTER, READABLE_COLUMN } from "@/components/ui/page-layout";
import { Blank, TitleHero, TitleTopBar } from "@/components/title/title-hero";
import { initialSeason } from "@/components/title/title-model";
import { useOpeningEpisodes } from "@/components/title/use-opening-episodes";
import {
  AboutRow,
  AvailableVersions,
  CastAndCrew,
  HeldSimilar,
  MoreLikeThis,
} from "@/components/title/title-sections";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useScreenOpenMark } from "@/lib/app-events";
import type { SeasonEpisode, TitleCard, TitleDetail, TitleId } from "@/lib/catalog";
import { useHandedCard } from "@/lib/open-title";
import { episodeLayout, heroHeight, rowsOf, topBarFade } from "@/lib/title-layout";
import { useWidthClass } from "@/lib/use-width-class";

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

/** What the title page shows while the title's answer is on its way, shaped like a season's rows. */
function EpisodesBlank() {
  return (
    <View className="gap-4">
      {[0, 1, 2].map((row) => (
        <View key={row} className="flex-row items-center gap-3 px-5">
          <Blank className="h-19 w-32" />
          <View className="flex-1 gap-2">
            <Blank className="h-4 w-3/4" />
            <Blank className="h-3 w-1/3" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The title's page. Until the title answers (`detail` null), it draws from `card`, the card a press
 * handed it, and holds the other sections' places with blank shapes; with no card, as from a link,
 * every section is a blank shape. One list stays mounted throughout, so what the card drew stays in
 * place as the answer fills in around it.
 */
function TitleDetailView({
  titleId,
  card,
  detail,
}: {
  readonly titleId: TitleId;
  readonly card: TitleCard | null;
  readonly detail: TitleDetail | null;
}) {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ season?: string }>();
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.set(event.contentOffset.y);
  });

  const title = detail ?? card;
  const opening = detail === null ? null : initialSeason(detail);
  // The list keeps the season it opened on, from the title's first answer, while the screen is
  // open, so its heading and the pages it has loaded stay on one season when the next episode
  // moves to another. Undefined until the title answers.
  const [opened, setOpened] = useState(() => (detail === null ? undefined : opening));

  if (opened === undefined && detail !== null) setOpened(opening);

  const seasonNumber = detail === null ? null : (seasonParam(params.season) ?? opened ?? opening);
  const [named, setNamed] = useState(false);
  const show = title?.kind === "show";
  // Only the season the list opened on reads the held page: a season the person picked stays
  // named, so its loaded pages stay when the opening season moves onto it.
  const held = !named && opened !== undefined && opened !== null && seasonNumber === opened;
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const widthClass = useWidthClass();
  const phone = widthClass === "compact";
  const hero = heroHeight(windowHeight, widthClass);
  const layout = episodeLayout(widthClass);
  const openActions = () => router.push(`/title/${titleId}/actions`);
  // The sections below the hero join a frame after the page first draws: a page that opens with
  // the title's answer already held would otherwise draw them all in the commit that starts the
  // push, and hold the push back until they are laid out.
  const [pastFirstFrame, setPastFirstFrame] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPastFirstFrame(true));

    return () => cancelAnimationFrame(frame);
  }, []);

  const episodes = useAllPages(
    platform.movies.titles.episodes,
    show && seasonNumber !== null
      ? (paginationOpts) => seasonPageArgs(titleId, seasonNumber, held, paginationOpts)
      : "skip",
  );

  const ofSeason =
    episodes.status === "ready" &&
    seasonNumber !== null &&
    allOfSeason(episodes.rows, seasonNumber);

  // The held page moved to another season before the title said so: ask for this one by number.
  if (held && episodes.status === "ready" && !ofSeason) setNamed(true);

  return (
    <View className="flex-1 bg-bg">
      <Animated.FlatList
        data={rowsOf(
          ofSeason ? episodes.rows : NO_EPISODES,
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
              detail={detail}
              scrollY={scrollY}
              widthClass={widthClass}
              height={hero}
              onMore={openActions}
            />
            {phone && title !== null && !show ? (
              <View className="gap-3 px-5">
                <AboutRow title={title} />
              </View>
            ) : null}
            {show && detail === null ? (
              <>
                <View className={GUTTER}>
                  <Blank className="h-6 w-32" />
                </View>
                <EpisodesBlank />
              </>
            ) : null}
            {detail !== null && show && seasonNumber !== null ? (
              <SeasonHeading title={detail} seasonNumber={seasonNumber} />
            ) : null}
            {show && seasonNumber !== null && episodes.status === "loading" ? (
              <EpisodesBlank />
            ) : null}
            {episodes.status === "failed" ? (
              <View className={`items-start gap-2 ${GUTTER}`}>
                <Text variant="meta" tone="danger">
                  {episodes.message}
                </Text>
                <Button label="Try Again" variant="secondary" onPress={episodes.retry} />
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          detail === null || !pastFirstFrame ? undefined : (
            <View
              className={`gap-6 pt-2 regular:gap-10 ${show ? "regular:pt-10" : "regular:pt-0"}`}
            >
              <View className={`gap-6 regular:gap-8 ${READABLE_COLUMN}`}>
                {phone ? show ? <AboutRow title={detail} /> : null : <AboutRow title={detail} />}
                <CastAndCrew title={detail} />
                <AvailableVersions title={detail} />
              </View>
              <MoreLikeThis titleId={titleId} />
            </View>
          )
        }
      />
      <TitleTopBar
        name={title?.name ?? ""}
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

/**
 * Identity rule: everything the page draws belongs to `titleId`, its route's title. The card comes
 * from the handoff under that id, read once as the page mounts, and the answer from
 * `titles.get({ titleId })`; the screen remounts this loader when its title changes, so neither a
 * card nor a late answer for one title ever draws on another's page.
 */
function TitleLoader({ titleId }: { readonly titleId: TitleId }) {
  const platform = usePlatform();
  const handed = useHandedCard(titleId);
  const title = usePlatformQuery(platform.movies.titles.get, { titleId });

  useOpeningEpisodes(titleId);
  // The open's content is the title's answer, not the card drawn before it: the mark renders with
  // the answer, so "content ready" is the first refresh after the answer was committed.
  const openMark = useScreenOpenMark("title", titleId, title.status === "success");

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

  if (title.status === "success" && !title.data.available) {
    return (
      <>
        <FileUnavailable title={title.data} />
        {openMark}
      </>
    );
  }

  return (
    <>
      <TitleDetailView
        titleId={titleId}
        // A title whose files are missing gets another page, which a card can't draw.
        card={handed?.available === true ? handed : null}
        detail={title.status === "success" ? title.data : null}
      />
      {openMark}
    </>
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

  return (
    <>
      <HeldSimilar titleId={titleId} />
      <TitleLoader key={titleId} titleId={titleId} />
    </>
  );
}
