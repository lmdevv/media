/**
 * The browse rows (A04–A10): a song with its ellipsis menu, an album, and an artist, on Paper's
 * 64pt row. Rows sit on the page's 20pt edge themselves, since a recycled list has no padded
 * container to put them in.
 */
import type { AlbumCard, ArtistCard } from "@music/commands/models";
import { router } from "expo-router";
import { View } from "react-native";

import { useSongDownloadLine } from "@/components/downloads/song-download";
import { Row, RowChevron, RowMore } from "@/components/ui/row";
import { songSheetParams } from "@/lib/song-sheet";
import type { SheetSong } from "@/lib/song-sheet";

/** Opens Song actions (A11) for `song`. */
export const openSongActions = (song: SheetSong): void => {
  router.push({ pathname: "/song/[id]/actions", params: songSheetParams(song) });
};

/** Opens an album in the current tab's stack. */
export const openAlbum = (album: Pick<AlbumCard, "id">): void => {
  router.push({ pathname: "/album/[id]", params: { id: album.id } });
};

/** Opens an artist in the current tab's stack. */
export const openArtist = (artist: Pick<ArtistCard, "id">): void => {
  router.push({ pathname: "/artist/[id]", params: { id: artist.id } });
};

/**
 * A song: art, title, artist with its download state, and its actions. The playing song's title is
 * the accent.
 */
export function TrackRow({
  song,
  artUrl,
  subtitle,
  active,
  onPress,
}: {
  readonly song: SheetSong;
  readonly artUrl: string | null;
  /** The artist by default; search results say more. */
  readonly subtitle?: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const line = useSongDownloadLine(song.id, song.title, subtitle ?? song.artist, onPress);

  return (
    <View className="px-page">
      <Row
        {...line}
        title={song.title}
        leading={{ kind: "art", url: artUrl, recyclingKey: song.id }}
        active={active}
        onLongPress={() => openSongActions(song)}
        trailingAction={
          <RowMore label={`More, ${song.title}`} onPress={() => openSongActions(song)} />
        }
      />
    </View>
  );
}

/** What an album row shows. */
type AlbumLine = Pick<AlbumCard, "id" | "title" | "artist" | "year" | "artUrl">;

/** An album as a row: art, title, and artist with the year. */
export function AlbumRow({
  album,
  onPress,
}: {
  readonly album: AlbumLine;
  readonly onPress?: () => void;
}) {
  return (
    <View className="px-page">
      <Row
        title={album.title}
        subtitle={album.year === null ? album.artist : `${album.artist} · ${String(album.year)}`}
        leading={{ kind: "art", url: album.artUrl, recyclingKey: album.id }}
        trailing={<RowChevron />}
        onPress={onPress ?? (() => openAlbum(album))}
      />
    </View>
  );
}

/** An artist as a row: art, name, and how many of their albums the library holds. */
export function ArtistRow({
  artist,
  subtitle,
  onPress,
}: {
  readonly artist: ArtistCard;
  readonly subtitle: string;
  readonly onPress?: () => void;
}) {
  return (
    <View className="px-page">
      <Row
        title={artist.name}
        subtitle={subtitle}
        leading={{ kind: "art", url: artist.artUrl, recyclingKey: artist.id }}
        trailing={<RowChevron />}
        onPress={onPress ?? (() => openArtist(artist))}
      />
    </View>
  );
}
