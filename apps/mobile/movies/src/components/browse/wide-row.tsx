import type { TitleCard } from "@/lib/catalog";
import { Link, router } from "expo-router";
import { Ellipsis, Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { kindFacts } from "@/lib/browse";
import { openTitle } from "@/lib/open-title";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { useTitleMenu } from "./title-menu";

/** A title row that opens the title. */
export function WideRow({ title }: { readonly title: TitleCard }) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");
  const menu = useTitleMenu({ title, episode: null }, watchHref({ titleId: title.id }));
  const detail = kindFacts(title);

  // The row is the button, so VoiceOver reaches it: content inside a `Link.Trigger` loses its own
  // accessibility element. The trigger is a view inside it that holds the preview and menu and
  // takes no press. The button sits in its own row beside `…`: the preview and menu render beside
  // the row and would take a parent's gap of their own, and `…` stays a separate VoiceOver element.
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title.name}, ${detail}`}
        accessibilityHint="Opens the title. Touch and hold for actions."
        onPress={(press) => openTitle(title.id, press)}
        className="flex-1 active:opacity-80"
      >
        <Link href={`/title/${title.id}`} asChild>
          <Link.Trigger>
            <View className="flex-row items-center gap-3">
              <View className="h-19 w-32 overflow-hidden rounded-control bg-surface-raised">
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
              <View className="flex-1 gap-1">
                <Text variant="labelStrong" numberOfLines={2}>
                  {title.name}
                </Text>
                <Text variant="meta" tone="muted" numberOfLines={1}>
                  {detail}
                </Text>
              </View>
            </View>
          </Link.Trigger>
          <Link.Preview />
          {menu}
        </Link>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More for ${title.name}`}
        hitSlop={12}
        onPress={() => router.push(`/title/${title.id}/actions`)}
        className="w-7 items-center active:opacity-60"
      >
        <Icon icon={Ellipsis} size="row" />
      </Pressable>
    </View>
  );
}
