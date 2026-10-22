/**
 * Paper's album card: art with 12pt corners, then the title at 16/24 semibold and the artist at
 * 13/18 muted. Rails use 168pt cards (A01) and the Albums grid lets the card fill its column
 * (A03). The artist page (A08b) uses 160pt cards with the year in place of the artist, whom the
 * page already names. Tapping opens the album in the current tab's stack.
 */
import type { AlbumCard as Album } from "@music/commands/models";
import { Pressable, View } from "react-native";

import { Artwork } from "@/components/ui/artwork";
import { Text } from "@/components/ui/text";

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
  readonly album: Album;
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
