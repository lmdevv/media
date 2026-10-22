/**
 * A05 · Songs: every song in the library, by title or by artist, with Play and Shuffle for all of
 * them. A row plays the list from that song; its ellipsis opens Song actions (A11), and the bar's
 * ellipsis opens Sort and view (A12). Pages load as the list nears its end.
 */
import { useRead, useReadOnce } from "@music/sdk/react";
import { router } from "expo-router";
import { Ellipsis, Music } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { useBrowseView } from "@/components/browse/browse-view-store";
import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { PlayShuffle } from "@/components/browse/play-shuffle";
import { TrackRow } from "@/components/browse/rows";
import { useTrackPages } from "@/components/browse/use-pages";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { songsArriveSorted, sortSongs } from "@/lib/browse-view";
import { countOf } from "@/lib/format";
import { readPages } from "@/lib/page-chain";
import { useNowPlaying } from "@/player";

/** Songs per page; one page holds a small library whole. */
const PAGE_SIZE = 100;

/** The most songs one queue takes, as `playback.play` allows. */
const QUEUE_LIMIT = 2000;

export default function Songs() {
  const { sort } = useBrowseView().songs;
  const pages = useTrackPages({ limit: PAGE_SIZE, all: !songsArriveSorted(sort) });
  const home = useRead("library.home", {});
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();
  const readTracks = useReadOnce("tracks.list");
  const [reading, setReading] = useState(false);

  const tracks = sortSongs(pages.items, sort);
  const trackIds = tracks.map((track) => track.id);
  const done = pages.status.kind === "done";

  // Play and Shuffle take the whole library, so read the pages not scrolled to yet.
  const playLibrary = async (shuffle: boolean) => {
    if (done) {
      playAll(trackIds, shuffle);

      return;
    }

    setReading(true);

    try {
      const all = await readPages((cursor) => readTracks({ cursor, limit: 200 }), QUEUE_LIMIT);
      playAll(
        sortSongs(all, sort).map((track) => track.id),
        shuffle,
      );
    } catch {
      playAll(trackIds, shuffle);
    } finally {
      setReading(false);
    }
  };

  return (
    <ListPage
      bar={{
        title: "Songs",
        trailing: (
          <IconButton
            icon={Ellipsis}
            label="Sort and view"
            onPress={() => router.push({ pathname: "/sort/[list]", params: { list: "songs" } })}
          />
        ),
      }}
      data={tracks}
      extraData={playingId}
      keyExtractor={(track) => track.id}
      onEndReached={pages.loadMore}
      onEndReachedThreshold={1}
      header={
        <View className="px-mobile-edge">
          <Text variant="callout" tone="muted">
            {home === undefined ? " " : countOf(home.stats.tracks, "song")}
          </Text>
          <PlayShuffle
            className="py-4"
            pending={reading || (!done && tracks.length === 0)}
            onPlay={() => void playLibrary(false)}
            onShuffle={() => void playLibrary(true)}
          />
        </View>
      }
      footer={
        done && tracks.length === 0 ? (
          <View className="px-mobile-edge">
            <EmptyState
              icon={Music}
              title={"No songs\nyet."}
              body={"Songs show up here once\na library has been scanned."}
            />
          </View>
        ) : null
      }
      renderItem={({ item, index }) => (
        <TrackRow
          song={item}
          artUrl={item.artUrl}
          active={item.id === playingId}
          onPress={() => playFrom(trackIds, index)}
        />
      )}
    />
  );
}
