/**
 * D10 · Downloaded: what this iPhone keeps. Chips pick all downloads, albums, playlists, or every
 * song here; a summary says how many songs, albums, and playlists take how much space, and how much
 * is still free. A download still coming says how far it got. Albums and playlists open their own
 * pages; songs downloaded on their own share one Songs row (D10b), which opens them (D10c). While
 * the server is out of reach the offline bar sits over the chips (D12).
 */
import type {
  DownloadedCollection,
  DownloadedEntry,
  LocalCopy,
  OfflineLibrary,
} from "@music/sdk/downloads";
import { targetKey } from "@music/sdk/downloads";
import { Match } from "effect";
import { router } from "expo-router";
import { CircleArrowDown } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { openAlbum } from "@/components/browse/rows";
import { DownloadedRow } from "@/components/downloads/downloaded-row";
import { LocalSongRow } from "@/components/downloads/local-song-row";
import { openRemoveDownload } from "@/components/downloads/remove-download";
import { StorageSummary } from "@/components/downloads/storage-summary";
import { OfflineNotice } from "@/components/states/offline-notice";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { useDownloadsLibrary } from "@/downloads";
import {
  DOWNLOADED_FILTERS,
  downloadedEmpty,
  downloadedLine,
  downloadedNote,
  downloadedSummary,
  entriesFor,
  ownSongsLine,
  removableSongs,
} from "@/lib/downloaded";
import type { DownloadedFilter } from "@/lib/downloaded";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useNowPlaying } from "@/player";

type Cell =
  | DownloadedEntry
  | { readonly kind: "song"; readonly copy: LocalCopy; readonly index: number };

const cellKey = (cell: Cell): string =>
  Match.value(cell).pipe(
    Match.discriminatorsExhaustive("kind")({
      song: ({ copy }) => copy.track.id,
      songs: () => "songs",
      download: ({ item }) => targetKey(item.target),
    }),
  );

function CollectionRow({ item }: { readonly item: DownloadedCollection }) {
  const { target } = item;

  const open = () => {
    if (target.kind === "album") openAlbum({ id: target.id });
    else router.push({ pathname: "/playlist/[id]", params: { id: target.id } });
  };

  return (
    <DownloadedRow
      title={item.title}
      line={downloadedLine(item)}
      artUri={item.artUri}
      recyclingKey={targetKey(target)}
      bytes={item.bytes}
      onPress={open}
      onRemove={() => {
        openRemoveDownload(target, item.title);
      }}
    />
  );
}

/** The chips, then the storage summary, over the list. */
function Summary({
  library: { downloads, usage },
  filter,
  onFilter,
}: {
  readonly library: OfflineLibrary;
  readonly filter: DownloadedFilter;
  readonly onFilter: (filter: DownloadedFilter) => void;
}) {
  return (
    <View className="px-page">
      <OfflineNotice variant="bar" />
      <ChipGroup label="Show" options={DOWNLOADED_FILTERS} value={filter} onChange={onFilter} />
      <StorageSummary
        line={downloadedSummary(usage, downloads)}
        bytes={usage.bytes}
        note={downloadedNote(usage, DEVICE_FAMILY)}
      />
    </View>
  );
}

export default function Downloaded() {
  const library = useDownloadsLibrary();
  const { downloads, entries, songs } = library;
  const { playFrom } = usePlayList();
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const [filter, setFilter] = useState<DownloadedFilter>("all");
  const songIds = songs.map((copy) => copy.track.id);
  const removable = removableSongs(downloads);

  const cells: ReadonlyArray<Cell> =
    filter === "songs"
      ? songs.map((copy, index) => ({ kind: "song", copy, index }))
      : entriesFor(filter, entries);

  return (
    <ListPage
      bar={{ title: "Downloaded" }}
      data={cells}
      extraData={playingId}
      keyExtractor={cellKey}
      getItemType={(cell) =>
        cell.kind === "song" && removable.has(cell.copy.track.id) ? "removable-song" : cell.kind
      }
      header={<Summary library={library} filter={filter} onFilter={setFilter} />}
      footer={
        cells.length === 0 ? (
          <EmptyState
            icon={CircleArrowDown}
            {...downloadedEmpty(filter, downloads.length > 0 || songs.length > 0)}
          />
        ) : null
      }
      renderItem={({ item: cell }) =>
        Match.value(cell).pipe(
          Match.discriminatorsExhaustive("kind")({
            song: ({ copy, index }) => (
              <LocalSongRow
                copy={copy}
                active={copy.track.id === playingId}
                showSize
                onPress={() => playFrom(songIds, index)}
                onRemove={
                  removable.has(copy.track.id)
                    ? () => {
                        openRemoveDownload({ kind: "track", id: copy.track.id }, copy.track.title);
                      }
                    : undefined
                }
              />
            ),
            songs: ({ songs: own }) => (
              <DownloadedRow
                title="Songs"
                line={ownSongsLine(own)}
                artUri={own.artUri}
                recyclingKey="songs"
                bytes={own.bytes}
                onPress={() => router.push("/downloaded/songs")}
              />
            ),
            download: ({ item }) => <CollectionRow item={item} />,
          }),
        )
      }
    />
  );
}
