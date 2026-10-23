/**
 * A pushed page whose body is a long list of songs (C02, C03, C11): Paper's nav bar stuck to the
 * top, the page's own header (hero, privacy row, Play and Shuffle), then one row per song in a
 * FlashList, so a playlist of two thousand songs scrolls as lightly as one of twenty. The list is
 * the page's content, so scrolling it minimizes the system tab bar.
 */
import { FlashList } from "@shopify/flash-list";
import type { ReactNode } from "react";
import { View } from "react-native";

import { openSongActions } from "@/components/browse/rows";
import { useSongDownloadLine } from "@/components/downloads/song-download";
import { ContentScroll } from "@/components/ui/content-scroll";
import { NavBar } from "@/components/ui/nav-bar";
import type { NavBarProps } from "@/components/ui/nav-bar";
import { Row, RowMore } from "@/components/ui/row";
import type { SheetSong } from "@/lib/song-sheet";
import { useNowPlaying } from "@/player";

/** One song of the list, ready to draw. */
export interface SongEntry {
  /** Unique within the list: a playlist entry's ID, since a song can appear twice. */
  readonly key: string;
  /** Null for a song in a library the viewer can't open. */
  readonly song: SheetSong | null;
  readonly title: string;
  readonly subtitle: string;
  readonly artUrl: string | null;
  /** False for a song that can't play here; its row stays, dimmed, without actions. */
  readonly playable: boolean;
}

/** What the list holds: the bar, the page's header, then its songs. */
type Cell =
  | { readonly kind: "bar" }
  | { readonly kind: "header" }
  | { readonly kind: "song"; readonly entry: SongEntry; readonly playIndex: number };

/** The bar is the list's first cell, and stays at the top. */
const STICKY_BAR = [0];

/** Props for `SongListPage`. */
export interface SongListPageProps {
  readonly bar: NavBarProps;
  /** Everything between the bar and the first song. */
  readonly header: ReactNode;
  readonly songs: ReadonlyArray<SongEntry>;
  /** Plays the list from the tapped song; `index` counts playable songs only. */
  readonly onPlay: (index: number) => void;
  /** Called near the end of the list, to load the next page. */
  readonly onEndReached?: () => void;
}

/** One song row; a song that can't play is dimmed and does nothing. */
function SongRow({
  entry,
  active,
  onPress,
}: {
  readonly entry: SongEntry;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const { song } = entry;

  const line = useSongDownloadLine(
    song?.id ?? null,
    entry.title,
    entry.subtitle,
    entry.playable ? onPress : undefined,
  );

  return (
    <View className={`px-mobile-edge ${entry.playable ? "" : "opacity-disabled"}`}>
      <Row
        {...line}
        title={entry.title}
        active={active}
        leading={{ kind: "art", url: entry.artUrl, recyclingKey: entry.key }}
        trailing={
          song === null || !entry.playable ? undefined : (
            <RowMore label={`More, ${entry.title}`} onPress={() => openSongActions(song)} />
          )
        }
      />
    </View>
  );
}

/** A song-list page with the playing song marked in accent. */
export function SongListPage({ bar, header, songs, onPlay, onEndReached }: SongListPageProps) {
  const { nowPlaying } = useNowPlaying();
  const playingId = nowPlaying?.trackId ?? null;

  // Tapping a song plays the playable songs from it, so it counts only the playable ones above it.
  const cells: Array<Cell> = [{ kind: "bar" }, { kind: "header" }];
  let playable = 0;

  for (const entry of songs) {
    cells.push({ kind: "song", entry, playIndex: playable });

    if (entry.playable) playable += 1;
  }

  return (
    <ContentScroll>
      <FlashList
        data={cells}
        extraData={playingId}
        stickyHeaderIndices={STICKY_BAR}
        contentInsetAdjustmentBehavior="never"
        keyExtractor={(cell) => (cell.kind === "song" ? cell.entry.key : cell.kind)}
        getItemType={(cell) => cell.kind}
        onEndReached={onEndReached}
        onEndReachedThreshold={1}
        ListFooterComponent={<View className="h-ios-180" />}
        renderItem={({ item }) => {
          if (item.kind === "bar") return <NavBar {...bar} />;

          if (item.kind === "header") return <View className="px-mobile-edge">{header}</View>;

          return (
            <SongRow
              entry={item.entry}
              active={item.entry.song !== null && item.entry.song.id === playingId}
              onPress={() => onPlay(item.playIndex)}
            />
          );
        }}
      />
    </ContentScroll>
  );
}
