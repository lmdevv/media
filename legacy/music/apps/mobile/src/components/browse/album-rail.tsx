import { FlatList, View } from "react-native";

import { SectionHeader } from "@/components/ui/section-header";
import type { SectionAction } from "@/components/ui/section-header";
import type { CardAlbum } from "@/lib/offline-library";

import { AlbumCard } from "./album-card";

export interface AlbumRailProps {
  readonly title: string;
  readonly albums: ReadonlyArray<CardAlbum>;
  readonly action?: SectionAction | undefined;
  readonly first?: boolean;
  /** 168pt cards on Home (A01); 160pt with the year on an artist's page (A08b). */
  readonly size?: "rail" | "artist";
}

/** A titled, sideways-scrolling row of albums; nothing when there are none. */
export function AlbumRail({ title, albums, action, first = false, size = "rail" }: AlbumRailProps) {
  if (albums.length === 0) return null;

  return (
    <View>
      <SectionHeader title={title} first={first} action={action} />
      <FlatList
        horizontal
        data={albums}
        keyExtractor={(album) => album.id}
        renderItem={({ item }) => <AlbumCard album={item} size={size} />}
        showsHorizontalScrollIndicator={false}
        className="bleed-page"
        contentContainerClassName="gap-3 px-page tablet:gap-4"
        initialNumToRender={3}
        windowSize={3}
      />
    </View>
  );
}
