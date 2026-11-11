import { Play } from "lucide-react-native";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import type { Episode } from "@/lib/catalog";
import { nextEpisodeFacts, secondsLeft } from "@/lib/player/next-episode";

/** Props for `NextEpisodeCard`. */
export interface NextEpisodeCardProps {
  readonly show: string;
  /** The episode playing, such as `S2, E3 · Who Is Alive?`. */
  readonly playing: string | null;
  readonly next: Episode;
  readonly stillUrl: string | undefined;
  readonly countdownMs: number;
  readonly onWatchCredits: () => void;
  readonly onPlayNext: () => void;
  /** The line above the episode's name in place of the countdown, such as why it cannot play. */
  readonly headline?: string | undefined;
}

/** The card and the titles beside it. */
export function NextEpisodeCard({
  show,
  playing,
  next,
  stillUrl,
  countdownMs,
  onWatchCredits,
  onPlayNext,
  headline,
}: NextEpisodeCardProps) {
  const insets = useSafeAreaInsets();
  const seconds = secondsLeft(countdownMs);

  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      className="absolute inset-0"
      style={{ paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: insets.bottom }}
      pointerEvents="box-none"
    >
      <View className="absolute inset-0 bg-scrim opacity-40" pointerEvents="none" />
      <View className="absolute bottom-12 left-8 gap-2" pointerEvents="none">
        <Text variant="largeTitle" tone="onMedia" numberOfLines={1}>
          {show}
        </Text>
        {playing === null ? null : (
          <Text variant="secondary" tone="darkMuted" numberOfLines={1}>
            {playing}
          </Text>
        )}
      </View>
      <View className="absolute right-6 bottom-6 w-95 gap-4 rounded-card bg-dark-surface-raised/94 p-4">
        <View className="flex-row items-center gap-4">
          <View className="h-19 w-32 overflow-hidden rounded-control bg-dark-surface">
            {stillUrl === undefined ? null : (
              <Image source={{ uri: stillUrl }} contentFit="cover" className="absolute inset-0" />
            )}
          </View>
          <View className="flex-1 gap-1">
            <Text variant="metaStrong" tone="darkMuted" accessibilityLiveRegion="polite">
              {headline ?? `Next Episode in ${String(seconds)}s`}
            </Text>
            <Text variant="heading" tone="onMedia" numberOfLines={1}>
              {next.name}
            </Text>
            <Text variant="meta" tone="darkMuted">
              {nextEpisodeFacts(next)}
            </Text>
          </View>
        </View>
        <View className="flex-row gap-2">
          <Pressable
            onPress={onWatchCredits}
            accessibilityRole="button"
            accessibilityLabel="Watch Credits"
            className="h-11 min-w-0 flex-1 items-center justify-center rounded-pill bg-dark-text/12 active:opacity-70"
          >
            <Text variant="labelStrong" tone="onMedia">
              Watch Credits
            </Text>
          </Pressable>
          <Pressable
            onPress={onPlayNext}
            accessibilityRole="button"
            accessibilityLabel="Play Next"
            className="h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-pill bg-accent active:bg-accent-pressed"
          >
            <Icon icon={Play} tone="onMedia" size="inline" filled />
            <Text variant="labelStrong" tone="onMedia">
              Play Next
            </Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}
