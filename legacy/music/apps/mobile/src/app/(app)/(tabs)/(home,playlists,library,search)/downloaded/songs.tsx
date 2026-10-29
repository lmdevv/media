/**
 * D10c · Songs: the songs downloaded on their own that no downloaded album or playlist holds,
 * opened from Downloaded's Songs row. Each says where it stands and the space it takes. A tap plays
 * the songs on this phone from that one, or a song still coming on its own; a swipe left uncovers
 * Remove (D10d).
 */
import { targetKey } from "@music/sdk/downloads";
import { CircleArrowDown } from "lucide-react-native";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { DownloadedRow } from "@/components/downloads/downloaded-row";
import { openRemoveDownload } from "@/components/downloads/remove-download";
import { StorageSummary } from "@/components/downloads/storage-summary";
import { OfflineNotice } from "@/components/states/offline-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { useDownloadsLibrary } from "@/downloads";
import {
  OWN_SONGS_EMPTY,
  OWN_SONGS_NOTE,
  ownSongLine,
  ownSongsQueue,
  ownSongsSummary,
} from "@/lib/downloaded";
import { useNowPlaying } from "@/player";

export default function DownloadedSongs() {
  const { ownSongs } = useDownloadsLibrary();
  const { playFrom } = usePlayList();
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;

  return (
    <ListPage
      bar={{ title: "Songs" }}
      data={ownSongs.items}
      extraData={playingId}
      keyExtractor={(item) => targetKey(item.target)}
      header={
        <View className="px-mobile-edge">
          <OfflineNotice variant="bar" />
          <StorageSummary
            line={ownSongsSummary(ownSongs)}
            bytes={ownSongs.bytes}
            note={OWN_SONGS_NOTE}
          />
        </View>
      }
      footer={
        ownSongs.items.length === 0 ? (
          <EmptyState icon={CircleArrowDown} {...OWN_SONGS_EMPTY} />
        ) : null
      }
      renderItem={({ item }) => (
        <DownloadedRow
          title={item.title}
          line={ownSongLine(item)}
          artUri={item.artUri}
          recyclingKey={targetKey(item.target)}
          bytes={item.bytes}
          active={item.target.id === playingId}
          onPress={() => {
            const queue = ownSongsQueue(ownSongs.items, item);
            playFrom(queue.trackIds, queue.index);
          }}
          onRemove={() => {
            openRemoveDownload(item.target, item.title);
          }}
        />
      )}
    />
  );
}
