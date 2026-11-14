import { Pressable, View } from "react-native";

import { Artwork } from "@/components/ui/artwork";
import { Text } from "@/components/ui/text";
import type { CardAlbum } from "@/lib/offline-library";

import { openAlbum } from "./rows";

const SIZES = {
  rail: { card: "w-ios-168", art: "size-ios-168" },
  artist: { card: "w-ios-160", art: "size-ios-160" },
  fill: { card: "w-full", art: "aspect-square w-full" },
} as const;

/** How wide a card is. */
type AlbumCardSize = keyof typeof SIZES;

/** One album as a card. */
export function AlbumCard({
  album,
  size = "rail",
  onPress,
}: {
  readonly album: CardAlbum;
  readonly size?: AlbumCardSize;
  readonly onPress?: () => void;
}) {
  const { card, art } = SIZES[size];
  const year = album.year === null ? "" : String(album.year);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${album.title}, ${album.artist}`}
      onPress={onPress ?? (() => openAlbum(album))}
      className={`${card} gap-2 active:opacity-70`}
    >
      <Artwork url={album.artUrl} recyclingKey={album.id} className={`${art} rounded-lg`} />
      <View>
        <Text variant="bodyStrong" numberOfLines={1}>
          {album.title}
        </Text>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {size === "artist" ? year : album.artist}
        </Text>
      </View>
    </Pressable>
  );
}
