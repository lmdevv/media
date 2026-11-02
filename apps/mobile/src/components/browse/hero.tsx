import type { TitleCard, TitleDetail } from "@movies/contracts/models/catalog";
import { useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Check, Play, Plus } from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useUniwind } from "uniwind";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { heroFacts, playTarget } from "@/lib/browse";
import { billboardHeight, pageAt } from "@/lib/layout";
import { watchHref } from "@/lib/routes";
import { useThemeColor } from "@/lib/theme-color";
import { useWidthClass } from "@/lib/use-width-class";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

import { useTitleStates } from "./title-states";

/** Props for `Hero`. */
export interface HeroProps {
  /** The titles to page through, featured first. */
  readonly titles: ReadonlyArray<TitleCard>;
  /** The large title and filters drawn over the top of the artwork. */
  readonly header?: ReactNode;
}

const DARK_SCRIM_LOCATIONS = [0, 0.3, 0.96] as const;

const LIGHT_SCRIM_LOCATIONS = [0, 0.28, 0.8, 1] as const;

const BILLBOARD_SCRIM_LOCATIONS = [0, 0.26, 0.5, 0.96] as const;

const SIDE_SCRIM_LOCATIONS = [0, 0.55] as const;

const SIDE_SCRIM_START = { x: 0, y: 0 } as const;

const SIDE_SCRIM_END = { x: 1, y: 0 } as const;

function HeroPage({ title, width }: { readonly title: TitleCard; readonly width: number }) {
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");
  const logo = artworkUrl(mediaUrl, title.artwork.logo, "card");
  const scrim = useThemeColor("--color-scrim");
  const page = useThemeColor("--color-bg");
  const light = useUniwind().theme === "light";

  return (
    <View style={{ width }} className="h-full justify-end">
      {backdrop === undefined ? null : (
        <Image
          source={{ uri: backdrop }}
          contentFit="cover"
          contentPosition="top"
          transition={200}
          className="absolute inset-0"
          accessibilityIgnoresInvertColors
        />
      )}
      <LinearGradient
        colors={light ? [scrim, "transparent", scrim, page] : [scrim, "transparent", page]}
        locations={light ? LIGHT_SCRIM_LOCATIONS : DARK_SCRIM_LOCATIONS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title.name}
        accessibilityHint="Opens the title."
        onPress={() => router.push(`/title/${title.id}`)}
        className="items-center px-5 pb-37 active:opacity-80"
      >
        {logo === undefined ? (
          <Text
            variant="heroTitle"
            tone="onMedia"
            className="text-center"
            numberOfLines={2}
            adjustsFontSizeToFit
          >
            {title.name}
          </Text>
        ) : (
          <Image source={{ uri: logo }} contentFit="contain" className="h-20 w-70" />
        )}
      </Pressable>
    </View>
  );
}

function BillboardPage({ title, width }: { readonly title: TitleCard; readonly width: number }) {
  const { mediaUrl } = useServer();
  const artwork = title.artwork.backdrop ?? title.artwork.poster;
  const backdrop = artworkUrl(mediaUrl, artwork, "billboard");
  const position = title.artwork.backdrop === null ? "top" : "center";
  const scrim = useThemeColor("--color-scrim");
  const page = useThemeColor("--color-bg");
  const light = useUniwind().theme === "light";

  return (
    <View style={{ width }} className="h-full">
      {backdrop === undefined ? null : (
        <Image
          source={{ uri: backdrop }}
          contentFit="cover"
          contentPosition={position}
          // The original can be a 4K frame; decoding it at the page's size keeps each page's memory
          // to what the screen shows.
          enforceEarlyResizing
          transition={200}
          className="absolute inset-0"
          accessibilityIgnoresInvertColors
        />
      )}
      <LinearGradient
        colors={
          light ? [scrim, "transparent", scrim, page] : [scrim, "transparent", "transparent", page]
        }
        locations={light ? LIGHT_SCRIM_LOCATIONS : BILLBOARD_SCRIM_LOCATIONS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={[scrim, "transparent"]}
        locations={SIDE_SCRIM_LOCATIONS}
        start={SIDE_SCRIM_START}
        end={SIDE_SCRIM_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title.name}
        accessibilityHint="Opens the title."
        onPress={() => router.push(`/title/${title.id}`)}
        className="absolute inset-0"
      />
    </View>
  );
}

/** The paging billboard. */
export function Hero({ titles, header }: HeroProps) {
  const { width, height } = useWindowDimensions();
  const widthClass = useWidthClass();
  const billboard = widthClass !== "compact";
  const pagesKey = titles.map((title) => title.id).join();
  const [paging, setPaging] = useState({ pagesKey, index: 0 });
  const index = paging.pagesKey === pagesKey ? Math.min(paging.index, titles.length - 1) : 0;
  const current = titles[index];

  if (current === undefined) return null;

  const Page = billboard ? BillboardPage : HeroPage;

  return (
    <View
      style={widthClass === "compact" ? undefined : { height: billboardHeight(widthClass, height) }}
      className="h-146 bg-bg"
    >
      <FlatList
        // A new width makes a new list that opens on the current page: the old one would keep its
        // offset in the old page width and rest between two pages after the window turns.
        key={`${pagesKey}:${String(width)}`}
        horizontal
        pagingEnabled
        data={titles}
        keyExtractor={(title) => title.id}
        renderItem={({ item }) => <Page title={item} width={width} />}
        getItemLayout={(_, page) => ({ length: width, offset: width * page, index: page })}
        initialScrollIndex={index}
        // An iPad's pages each hold a full-size backdrop, so only the page and its neighbours mount.
        initialNumToRender={billboard ? 1 : undefined}
        windowSize={billboard ? 3 : undefined}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setPaging({
            pagesKey,
            index: pageAt(event.nativeEvent.contentOffset.x, width, titles.length),
          })
        }
        className="absolute inset-0"
        accessibilityRole="adjustable"
      />
      <View className="absolute inset-x-0 top-0" pointerEvents="box-none">
        {header}
      </View>
      {billboard ? (
        <BillboardDetails title={current} pages={titles.length} index={index} />
      ) : (
        <HeroDetails title={current} pages={titles.length} index={index} />
      )}
    </View>
  );
}

function PageDots({
  pages,
  index,
  className,
}: {
  readonly pages: number;
  readonly index: number;
  readonly className: string;
}) {
  return (
    <View
      className={`h-3 flex-row items-center gap-1.5 ${className}`}
      accessibilityLabel={`Page ${index + 1} of ${pages}`}
    >
      {Array.from({ length: pages }, (_, page) => (
        <View
          key={page}
          className={
            page === index
              ? "h-1.5 w-5 rounded-pill bg-text"
              : "size-1.5 rounded-pill bg-text-muted"
          }
        />
      ))}
    </View>
  );
}

const useFeaturedDetail = (title: TitleCard): TitleDetail | null => {
  const { profile } = useActiveProfile();
  const detail = useCommandQuery("titles.get", { profileId: profile.id, titleId: title.id });

  return detail.status === "success" ? detail.data : null;
};

function HeroActions({
  title,
  detail,
  className,
  playClassName,
  listSize,
}: {
  readonly title: TitleCard;
  readonly detail: TitleDetail | null;
  readonly className: string;
  readonly playClassName: string;
  readonly listSize: "control" | "large";
}) {
  const states = useTitleStates();
  const play = playTarget(title.id, detail);
  const inList = states.inMyList(title.id);

  return (
    <View className={`flex-row items-center gap-3 ${className}`} pointerEvents="box-none">
      {title.available ? (
        <Button
          label={play.label}
          icon={Play}
          iconFilled
          className={playClassName}
          onPress={() => router.push(play.href)}
        />
      ) : (
        <Button
          label="More Info"
          className={playClassName}
          onPress={() => router.push(`/title/${title.id}`)}
        />
      )}
      <IconButton
        icon={inList ? Check : Plus}
        label={inList ? `Remove ${title.name} from My List` : `Add ${title.name} to My List`}
        variant="glass"
        size={listSize}
        onPress={() => void (inList ? states.removeFromMyList(title) : states.addToMyList(title))}
      />
    </View>
  );
}

function BillboardDetails({
  title,
  pages,
  index,
}: {
  readonly title: TitleCard;
  readonly pages: number;
  readonly index: number;
}) {
  const { mediaUrl } = useServer();
  const loaded = useFeaturedDetail(title);
  const logo = artworkUrl(mediaUrl, title.artwork.logo, "card");

  return (
    <View className="absolute inset-x-0 bottom-0 px-8 pb-10 wide:px-12" pointerEvents="box-none">
      <View className="w-full max-w-130 gap-5" pointerEvents="box-none">
        <View className="gap-3" pointerEvents="none">
          {logo === undefined ? (
            <Text variant="billboard" tone="onMedia" numberOfLines={2} adjustsFontSizeToFit>
              {title.name}
            </Text>
          ) : (
            <Image
              source={{ uri: logo }}
              contentFit="contain"
              contentPosition="left"
              className="h-30 w-full"
              accessibilityLabel={title.name}
            />
          )}
          <Text variant="label" tone="onMedia" numberOfLines={1}>
            {heroFacts(title, loaded?.seasons.length ?? null)}
          </Text>
        </View>
        {loaded === null || loaded.overview === null ? null : (
          <Text variant="paragraph" tone="onMediaMuted" numberOfLines={2} pointerEvents="none">
            {loaded.overview}
          </Text>
        )}
        <HeroActions
          title={title}
          detail={loaded}
          className="pt-1"
          playClassName="min-w-50 px-8"
          listSize="control"
        />
      </View>
      {pages < 2 ? null : (
        <PageDots
          pages={pages}
          index={index}
          className="absolute right-8 bottom-15 wide:right-12"
        />
      )}
    </View>
  );
}

function HeroDetails({
  title,
  pages,
  index,
}: {
  readonly title: TitleCard;
  readonly pages: number;
  readonly index: number;
}) {
  const loaded = useFeaturedDetail(title);

  return (
    <View className="absolute inset-x-0 bottom-0 gap-4 px-5 pb-4" pointerEvents="box-none">
      <Text variant="metaStrong" tone="onMedia" className="text-center" numberOfLines={1}>
        {heroFacts(title, loaded?.seasons.length ?? null)}
      </Text>
      <HeroActions
        title={title}
        detail={loaded}
        className="px-12"
        playClassName="flex-1"
        listSize="large"
      />
      {pages < 2 ? (
        <View className="h-3" />
      ) : (
        <PageDots pages={pages} index={index} className="justify-center" />
      )}
    </View>
  );
}

/** The Kids billboard (C10): an inset card, the name, and Play. */
export function KidsHero({ title }: { readonly title: TitleCard }) {
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");

  return (
    <View className="gap-4 px-5 regular:px-8 wide:px-12">
      <View className="h-56 overflow-hidden rounded-card bg-surface-raised regular:h-90 wide:h-120">
        {backdrop === undefined ? null : (
          <Image
            source={{ uri: backdrop }}
            contentFit="cover"
            transition={200}
            className="size-full"
          />
        )}
      </View>
      <Text variant="title" numberOfLines={2}>
        {title.name}
      </Text>
      {title.available ? (
        <Button
          label="Play"
          icon={Play}
          iconFilled
          className="regular:min-w-50 regular:self-start regular:px-8"
          onPress={() => router.push(watchHref({ titleId: title.id }))}
        />
      ) : null}
    </View>
  );
}
