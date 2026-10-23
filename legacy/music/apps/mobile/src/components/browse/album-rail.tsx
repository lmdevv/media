/**
 * A horizontal rail of album cards under a section header (A01): two cards and a bit of the third
 * visible at 390pt, scrolling sideways. The rail runs edge to edge while its cards start on the
 * page's 20pt edge.
 */
import { FlatList, View } from "react-native";

import { SectionHeader } from "@/components/ui/section-header";
import type { SectionAction } from "@/components/ui/section-header";
import type { CardAlbum } from "@/lib/offline-library";

import { AlbumCard } from "./album-card";

/** Props for `AlbumRail`. */
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
        className="-mx-mobile-edge"
        contentContainerClassName="gap-3 px-mobile-edge"
        initialNumToRender={3}
        windowSize={3}
      />
    </View>
  );
}
