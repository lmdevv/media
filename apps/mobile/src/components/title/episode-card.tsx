import type { Episode } from "@media/contracts/models/catalog";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ellipsis, Play } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { progressFraction } from "@/lib/format";
import { watchHref } from "@/lib/routes";
import { useThemeColor } from "@/lib/theme-color";
import { useServer } from "@/session/connection";

import { episodeActionsHref } from "./episode-row";
import { episodeLine } from "./title-model";

/**
 * One episode in an iPad's episode grid, sharing its row's width with the others: its 16:9 still
 * with the play glyph and how far the profile got, then its name, running time, and two lines of
 * its overview. VoiceOver reaches its actions as the card's More action.
 */
export function EpisodeCard({ episode }: { readonly episode: Episode }) {
  const { mediaUrl } = useServer();
  const scrim = useThemeColor("--color-scrim");
  const still = artworkUrl(mediaUrl, episode.still, "card");
  const line = episodeLine(episode);
  const progress = line.watched ? 1 : progressFraction(episode.progress);
  const openActions = () => router.push(episodeActionsHref(episode));
  const overview = (episode.overview ?? "").trim();
  const label = [line.heading, line.meta, overview].filter((part) => part !== "").join(", ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Plays the episode"
      accessibilityState={{ disabled: !episode.available }}
      accessibilityActions={[{ name: "actions", label: "More" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "actions") openActions();
      }}
      // Not `disabled`, which would also block the long press that opens the actions.
      onPress={
        episode.available
          ? () => router.push(watchHref({ titleId: episode.titleId, episodeId: episode.id }))
          : undefined
      }
      onLongPress={openActions}
      className={`flex-1 gap-3 active:opacity-70 ${episode.available ? "" : "opacity-40"}`}
    >
      <View className="aspect-video w-full overflow-hidden rounded-control bg-surface">
        {still === undefined ? null : (
          <Image
            source={{ uri: still }}
            contentFit="cover"
            transition={150}
            className="size-full"
          />
        )}
        <View className="absolute inset-x-0 bottom-0 h-1/2">
          <LinearGradient colors={["transparent", scrim]} style={StyleSheet.absoluteFill} />
        </View>
        <View className="absolute bottom-3 left-3">
          <Icon icon={Play} tone="onMedia" size="inline" filled />
        </View>
        {progress === null || progress === 0 ? null : (
          <ProgressBar value={progress} overMedia className="absolute inset-x-0 bottom-0" />
        )}
      </View>
      <View className="gap-1">
        <View className="flex-row items-center gap-3">
          <Text variant="bodyStrong" className="flex-1" numberOfLines={2}>
            {line.heading}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`More for ${episode.name}`}
            hitSlop={8}
            onPress={openActions}
            className="h-11 w-7 items-center justify-center active:opacity-60"
          >
            <Icon icon={Ellipsis} size="row" />
          </Pressable>
        </View>
        {line.meta === "" ? null : (
          <Text variant="meta" tone="muted" numberOfLines={1}>
            {line.meta}
          </Text>
        )}
        {overview === "" ? null : (
          <Text variant="secondary" tone="muted" numberOfLines={2} className="pt-1">
            {overview}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
