import { ArtistId } from "@/lib/ids";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { PlayShuffle } from "@/components/browse/play-shuffle";
import { TrackRow } from "@/components/browse/rows";
import { useArtistSongPages } from "@/components/browse/use-pages";
import { Text } from "@/components/ui/text";
import { artistSongLine, distinctTracks } from "@/lib/artists";
import { readPages } from "@/lib/details";
import { countOf } from "@/lib/format";
import { useMusic, useReadSettled } from "@/lib/platform";
import { useNowPlaying } from "@/player";

const decodeId = Schema.decodeUnknownOption(ArtistId);

const PAGE_SIZE = 100;

/** The most songs Play and Shuffle queue, as the library's Songs page does. */
const QUEUE_LIMIT = 2000;

/**
 * Every song crediting the artist, by title, each once: their own, and the ones they share or only
 * feature on, a page at a time as the list nears its end.
 */
function ArtistSongs({ artistId }: { readonly artistId: ArtistId }) {
  const music = useMusic();
  const pages = useArtistSongPages(artistId, PAGE_SIZE);
  const found = useReadSettled(music.artists.get, { artistId });
  const artist = found === undefined || found instanceof Error ? null : found.artist;
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();
  const [reading, setReading] = useState(false);

  const tracks = pages.items;
  const trackIds = tracks.map((track) => track.id);
  const done = pages.status.kind === "done";

  const playEvery = async (shuffle: boolean) => {
    if (done) {
      playAll(trackIds, shuffle);

      return;
    }

    setReading(true);

    try {
      const every = await readPages(
        (paginationOpts) => music.artists.tracks({ artistId, paginationOpts }),
        QUEUE_LIMIT,
      );

      playAll(
        distinctTracks(every).map((track) => track.id),
        shuffle,
      );
    } catch {
      playAll(trackIds, shuffle);
    } finally {
      setReading(false);
    }
  };

  const summary =
    artist === null
      ? " "
      : [artist.name, artist.trackCount === undefined ? null : countOf(artist.trackCount, "song")]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <ListPage
      bar={{ title: "Songs" }}
      data={tracks}
      extraData={playingId}
      keyExtractor={(track) => track.id}
      onEndReached={pages.loadMore}
      onEndReachedThreshold={1}
      header={
        <View className="px-page">
          <Text variant="callout" tone="muted" numberOfLines={1}>
            {summary}
          </Text>
          <PlayShuffle
            className="py-4"
            pending={reading || (!done && tracks.length === 0)}
            onPlay={() => void playEvery(false)}
            onShuffle={() => void playEvery(true)}
          />
        </View>
      }
      renderItem={({ item, index }) => (
        <TrackRow
          song={item}
          artUrl={item.artUrl}
          subtitle={artistSongLine(item, artistId, null)}
          active={item.id === playingId}
          onPress={() => playFrom(trackIds, index)}
        />
      )}
    />
  );
}

export default function ArtistSongsScreen() {
  const artistId = Option.getOrNull(decodeId(useLocalSearchParams().id));

  return artistId === null ? (
    <ListPage bar={{ title: "Songs" }} data={[]} renderItem={() => null} />
  ) : (
    <ArtistSongs artistId={artistId} />
  );
}
