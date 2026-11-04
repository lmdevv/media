import type { Collection } from "@media/contracts/models/collections";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { titleCount } from "@/lib/browse";
import { useServer } from "@/session/connection";

const backdropOf = (collection: Collection): string | null =>
  collection.artwork.backdrop ??
  collection.titles.find((title) => title.artwork.backdrop !== null)?.artwork.backdrop ??
  null;

/** A tappable collection card that opens the collection. */
export function CollectionCard({
  collection,
  size,
}: {
  readonly collection: Collection;
  readonly size: "rail" | "wide";
}) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, backdropOf(collection), "card");
  const count = titleCount(collection.titles);
  const rail = size === "rail";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${collection.name}, ${count}`}
      onPress={() => router.push(`/collection/${collection.id}`)}
      className={`${rail ? "w-66 gap-1.5 regular:w-80 regular:gap-2 wide:w-90" : "w-full gap-2"} active:opacity-80`}
    >
      <View
        className={`overflow-hidden bg-surface-raised ${
          rail ? "h-37 rounded-control regular:h-45 wide:h-50.75" : "h-45 rounded-card"
        }`}
      >
        {uri === undefined ? null : (
          <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
        )}
      </View>
      {rail ? (
        <View className="gap-0.5">
          <Text variant="railCardName" numberOfLines={1}>
            {collection.name}
          </Text>
          <Text variant="meta" tone="muted" className="hidden regular:flex">
            {count}
          </Text>
        </View>
      ) : (
        <>
          <Text variant="title" numberOfLines={2}>
            {collection.name}
          </Text>
          <Text variant="secondary" tone="muted">
            {count}
          </Text>
        </>
      )}
    </Pressable>
  );
}
