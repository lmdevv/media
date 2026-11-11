import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Check, ChevronLeft, Ellipsis, Play, Plus } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { GUTTER } from "@/components/ui/page-layout";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import type { TitleDetail } from "@/lib/catalog";
import { watchHref } from "@/lib/routes";
import { useThemeColor } from "@/lib/theme-color";
import type { WidthClass } from "@/lib/layout";
import type { FadeRange } from "@/lib/title-layout";
import { useServer } from "@/session/connection";

import { playAction, titleFacts } from "./title-model";
import { useMyListToggle } from "./use-title-actions";

function HeroArtwork({
  uri,
  height,
  besideText,
  scrollY,
}: {
  readonly uri: string | undefined;
  readonly height: number;
  /** On an iPad the name sits over the artwork's left side, which darkens toward the edge. */
  readonly besideText: boolean;
  readonly scrollY: SharedValue<number>;
}) {
  const scrim = useThemeColor("--color-scrim");
  const page = useThemeColor("--color-bg");

  const motion = useAnimatedStyle(() => {
    const y = scrollY.value;

    return y < 0
      ? { opacity: 1, transform: [{ translateY: y / 2 }, { scale: 1 - y / height }] }
      : {
          opacity: interpolate(y, [0, height], [1, 0], Extrapolation.CLAMP),
          transform: [{ translateY: y / 2 }, { scale: 1 }],
        };
  });

  return (
    <Animated.View
      className="absolute inset-x-0 top-0 bg-surface"
      style={[{ height }, motion]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {uri === undefined ? null : (
        <Image source={{ uri }} contentFit="cover" transition={200} className="size-full" />
      )}
      {besideText ? (
        <>
          <LinearGradient
            colors={[scrim, "transparent", "transparent", page, page]}
            locations={[0, 0.22, 0.45, 0.94, 1]}
            style={StyleSheet.absoluteFill}
          />
          <View className="absolute inset-y-0 left-0 w-5/6 opacity-70 wide:w-5/8">
            <LinearGradient
              colors={[page, "transparent"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </View>
        </>
      ) : (
        <LinearGradient
          colors={[scrim, "transparent", page]}
          locations={[0, 0.3, 1]}
          style={StyleSheet.absoluteFill}
        />
      )}
    </Animated.View>
  );
}

/** Props for `TitleHero`. */
export interface TitleHeroProps {
  readonly title: TitleDetail;
  readonly scrollY: SharedValue<number>;
  readonly widthClass: WidthClass;
  /** The hero's height in points, from `heroHeight`. */
  readonly height: number;
  /** Opens the title's actions, from the More button beside Play on an iPad. */
  readonly onMore: () => void;
}

/**
 * The artwork, the title, its facts, the play row, and the overview. On an iPhone they stack
 * centered under the artwork; on an iPad they sit at the artwork's bottom left, with the title's
 * More button beside Play.
 */
export function TitleHero({ title, scrollY, widthClass, height, onMore }: TitleHeroProps) {
  const insets = useSafeAreaInsets();
  const phone = widthClass === "compact";
  const { mediaUrl } = useServer();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");
  const logo = artworkUrl(mediaUrl, title.artwork.logo, "card");
  const play = playAction(title);
  const myList = useMyListToggle(title.id, title.inMyList);

  return (
    <View className="regular:justify-end" style={phone ? undefined : { minHeight: height }}>
      <HeroArtwork uri={backdrop} height={height} besideText={!phone} scrollY={scrollY} />
      <View style={{ height: insets.top }} />
      <View className={`gap-3 pt-56 pb-1 regular:items-start regular:pt-16 regular:pb-8 ${GUTTER}`}>
        {logo === undefined ? (
          <Text
            variant={phone ? "largeTitle" : "displayName"}
            className="text-center regular:text-left"
            accessibilityRole="header"
          >
            {title.name}
          </Text>
        ) : (
          <Image
            source={{ uri: logo }}
            contentFit="contain"
            contentPosition={phone ? "center" : "left"}
            className="h-20 w-full regular:max-w-readable"
            accessible
            accessibilityRole="header"
            accessibilityLabel={title.name}
          />
        )}
        <Text variant={phone ? "metaStrong" : "label"} className="text-center regular:text-left">
          {titleFacts(title)}
        </Text>
        <View className="flex-row items-center gap-3 regular:pt-2">
          <Button
            label={play.label}
            icon={Play}
            iconFilled
            className="flex-1 regular:min-w-50 regular:flex-none regular:px-8"
            disabled={!play.available}
            onPress={() => router.push(watchHref({ titleId: title.id, episodeId: play.episodeId }))}
          />
          <IconButton
            icon={myList.inList ? Check : Plus}
            label={myList.inList ? "Remove from My List" : "Add to My List"}
            variant="glass"
            size="control"
            onPress={() => void myList.toggle()}
          />
          {phone ? null : (
            <IconButton
              icon={Ellipsis}
              label="More"
              variant="glass"
              size="control"
              onPress={onMore}
            />
          )}
        </View>
        {myList.error === null ? null : (
          <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
            {myList.error}
          </Text>
        )}
        {title.overview === null ? null : (
          <Text numberOfLines={phone ? 4 : 3} className="regular:max-w-readable regular:pt-1">
            {title.overview}
          </Text>
        )}
      </View>
    </View>
  );
}

/** Props for `TitleTopBar`. */
export interface TitleTopBarProps {
  readonly name: string;
  readonly scrollY: SharedValue<number>;
  /** The scroll offsets across which the bar and its title fade in. */
  readonly fade: FadeRange;
  /** On an iPad the hero has its own More, so the bar's appears only as the hero scrolls away. */
  readonly moreInHero: boolean;
  readonly onMore: () => void;
}

/**
 * Back and More over the artwork, gaining a glass bar and the title once scrolled. On an iPad the
 * hero carries More beside Play, so the bar's More fades in with the bar.
 */
export function TitleTopBar({ name, scrollY, fade, moreInHero, onMore }: TitleTopBarProps) {
  const insets = useSafeAreaInsets();
  const [heroScrolledAway, setHeroScrolledAway] = useState(false);

  const compact = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [fade.from, fade.to], [0, 1], Extrapolation.CLAMP),
  }));

  // `moreInHero` belongs in the watched value: a compact window widened while scrolled is already
  // past the fade, so only the switch itself can bring the bar's More back.
  useAnimatedReaction(
    () => moreInHero && scrollY.value > fade.from,
    (away, before) => {
      if (away !== before) scheduleOnRN(setHeroScrolledAway, away);
    },
    [fade.from, moreInHero],
  );

  return (
    <View
      className="absolute inset-x-0 top-0"
      style={{ paddingTop: insets.top }}
      pointerEvents="box-none"
    >
      <Animated.View style={[StyleSheet.absoluteFill, compact]} pointerEvents="none">
        <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />
        <View className="absolute inset-0 bg-bg/60" />
      </Animated.View>
      <View className={`h-16 flex-row items-center gap-3 ${GUTTER}`} pointerEvents="box-none">
        <IconButton
          icon={ChevronLeft}
          label="Back"
          variant="glass"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <Animated.View style={compact} className="flex-1" pointerEvents="none">
          <Text variant="navTitle" numberOfLines={1} accessibilityElementsHidden>
            {name}
          </Text>
        </Animated.View>
        {moreInHero ? (
          heroScrolledAway ? (
            <Animated.View style={compact}>
              <IconButton icon={Ellipsis} label="More" variant="glass" onPress={onMore} />
            </Animated.View>
          ) : null
        ) : (
          <IconButton icon={Ellipsis} label="More" variant="glass" onPress={onMore} />
        )}
      </View>
    </View>
  );
}
