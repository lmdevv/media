import type { ContinueWatchingItem } from "@/lib/catalog";
import { Link, router } from "expo-router";
import { Info, Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { artworkUrl } from "@/lib/artwork";
import { episodeCode, facts, progressFraction, progressLabel } from "@/lib/format";
import { openTitle } from "@/lib/open-title";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { useSavedHome } from "./browse/held-home";
import { useTitleMenu } from "./browse/title-menu";
import { Icon } from "./ui/icon";
import { IconButton } from "./ui/icon-button";
import { Image } from "./ui/image";
import { ProgressBar } from "./ui/progress-bar";
import { Text } from "./ui/text";

/** The artwork's size, which the info button's layer matches to sit in its corner. */
const ARTWORK = "h-32.5 w-full regular:h-45 wide:h-50.75";

/**
 * One item to resume or start next: tapping the card plays it, touching and holding it opens the
 * menu a poster has, aimed at the item's episode, and the info button in the artwork's
 * bottom-right corner opens its title page. The card and the button are siblings, so each is its
 * own VoiceOver element and the button's tap never reaches the card.
 */
export function ContinueCard({ item }: { readonly item: ContinueWatchingItem }) {
  const { mediaUrl } = useServer();
  const still = item.episode?.still ?? item.title.artwork.backdrop ?? item.title.artwork.poster;
  const uri = artworkUrl(mediaUrl, still, "card");

  const fraction = progressFraction(item.progress);

  const label =
    item.episode === null ? item.title.name : `${item.title.name} · ${episodeCode(item.episode)}`;

  const saved = useSavedHome();

  const target = watchHref({
    titleId: item.title.id,
    episodeId: saved ? undefined : item.episode?.id,
  });

  const menu = useTitleMenu(item, target);

  // The card stays a plain button for VoiceOver: content inside a `Link.Trigger` loses its own
  // accessibility element. So the trigger is a view inside it, which holds the menu but takes no
  // press, and the card plays. No preview, since a preview of the player would start playing.
  return (
    <View className="w-58 regular:w-80 wide:w-90">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={facts(label, progressLabel(item.progress))}
        onPress={() => router.push(target)}
        className="active:opacity-80"
      >
        <Link href={target} asChild>
          <Link.Trigger>
            <View className="gap-2">
              <View className={`${ARTWORK} overflow-hidden rounded-control bg-surface-raised`}>
                {uri === undefined ? null : (
                  <Image
                    source={{ uri }}
                    contentFit="cover"
                    transition={150}
                    className="size-full"
                  />
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
            </View>
          </Link.Trigger>
          {menu}
        </Link>
      </Pressable>
      <View className={`absolute top-0 left-0 ${ARTWORK}`} pointerEvents="box-none">
        <IconButton
          icon={Info}
          label={`More info about ${item.title.name}`}
          variant="glass"
          className="absolute right-1 bottom-1"
          onPress={(press) => openTitle(item.title.id, press)}
        />
      </View>
    </View>
  );
}
