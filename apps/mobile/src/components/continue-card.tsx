import type { ContinueWatchingItem } from "@media/contracts/models/catalog";
import { router } from "expo-router";
import { Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { artworkUrl } from "@/lib/artwork";
import { episodeCode, facts, progressFraction, progressLabel } from "@/lib/format";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { Icon } from "./ui/icon";
import { Image } from "./ui/image";
import { ProgressBar } from "./ui/progress-bar";
import { Text } from "./ui/text";

/** One item to resume or start next. */
export function ContinueCard({ item }: { readonly item: ContinueWatchingItem }) {
  const { mediaUrl } = useServer();
  const still = item.episode?.still ?? item.title.artwork.backdrop ?? item.title.artwork.poster;
  const uri = artworkUrl(mediaUrl, still, "card");

  const fraction = progressFraction(item.progress);

  const label =
    item.episode === null ? item.title.name : `${item.title.name} · ${episodeCode(item.episode)}`;

  const target = watchHref({ titleId: item.title.id, episodeId: item.episode?.id });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={facts(label, progressLabel(item.progress))}
      onPress={() => router.push(target)}
      className="w-58 gap-2 active:opacity-80 regular:w-80 wide:w-90"
    >
      <View className="h-32.5 w-full overflow-hidden rounded-control bg-surface-raised regular:h-45 wide:h-50.75">
        {uri === undefined ? null : (
          <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
        )}
        <View className="absolute bottom-2 left-2">
          <Icon icon={Play} tone="onMedia" size="inline" filled />
        </View>
      </View>
      {fraction === null ? null : <ProgressBar value={fraction} />}
      <View className="flex-row items-baseline gap-2">
        <Text variant="labelStrong" className="flex-1" numberOfLines={1}>
          {label}
        </Text>
        {item.progress === null ? null : (
          <Text variant="meta" tone="muted">
            {progressLabel(item.progress)}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
