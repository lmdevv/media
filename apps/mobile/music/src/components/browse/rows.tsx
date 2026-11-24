import type { AlbumCard, ArtistCard } from "@/lib/models";
import { router } from "expo-router";
import { View } from "react-native";

import { useSongDownloadLine } from "@/components/downloads/song-download";
import { Row, RowChevron, RowMore } from "@/components/ui/row";
import { creditText } from "@/lib/credits";
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
 * A song: art, title, its artists with its download state, and its actions. The playing song's
 * title is the accent. The row's tap plays the song, so its artists show as one line of text.
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
  /** The song's artists by default; search results say more. */
  readonly subtitle?: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const line = useSongDownloadLine(song.id, song.title, subtitle ?? creditText(song), onPress);

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
type AlbumLine = Pick<AlbumCard, "id" | "title" | "artist" | "credits" | "year" | "artUrl">;

/** An album as a row: art, title, and its artists with the year. */
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
        subtitle={
          album.year === null ? creditText(album) : `${creditText(album)} · ${String(album.year)}`
        }
        leading={{ kind: "art", url: album.artUrl, recyclingKey: album.id }}
        trailing={<RowChevron />}
        onPress={onPress ?? (() => openAlbum(album))}
      />
    </View>
  );
}

/** An artist as a row: art, name, and what the library holds of theirs. */
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
