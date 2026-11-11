import type { Episode } from "@/lib/catalog";
import { router } from "expo-router";
import { Ellipsis, Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { episodeLine } from "./title-model";

/** Where an episode's More button and long press open its actions. */
export const episodeActionsHref = (episode: Episode): string =>
  `/title/${episode.titleId}/episode/${episode.id}?season=${episode.seasonNumber}`;

/** One episode row. */
export function EpisodeRow({ episode }: { readonly episode: Episode }) {
  const { mediaUrl } = useServer();
  const still = artworkUrl(mediaUrl, episode.still, "card");
  const line = episodeLine(episode);
  const openActions = () => router.push(episodeActionsHref(episode));

  return (
    <View className="flex-row items-center gap-3 px-5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={line.meta === "" ? line.heading : `${line.heading}, ${line.meta}`}
        accessibilityHint="Plays the episode"
        accessibilityState={{ disabled: !episode.available }}
        // Not `disabled`, which would also block the long press that opens the actions.
        onPress={
          episode.available
            ? () => router.push(watchHref({ titleId: episode.titleId, episodeId: episode.id }))
            : undefined
        }
        onLongPress={openActions}
        className={`flex-1 flex-row items-center gap-3 active:opacity-70 ${
          episode.available ? "" : "opacity-40"
        }`}
      >
        <View className="h-19 w-32 overflow-hidden rounded-control bg-surface-raised">
          {still === undefined ? null : (
            <Image
              source={{ uri: still }}
              contentFit="cover"
              transition={150}
              className="size-full"
            />
          )}
          <View className="absolute bottom-2 left-2">
            <Icon icon={Play} tone="onMedia" size="inline" filled />
          </View>
        </View>
        <View className="flex-1 gap-1">
          <Text variant="labelStrong" numberOfLines={2}>
            {line.heading}
          </Text>
          {line.meta === "" ? null : (
            <Text variant="meta" tone="muted" numberOfLines={1}>
              {line.meta}
            </Text>
          )}
          {line.watched ? <ProgressBar value={1} /> : null}
        </View>
      </Pressable>
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
  );
}
