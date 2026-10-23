/**
 * D10 · Downloaded: what this iPhone keeps. Chips pick all downloads, albums, playlists, or every
 * song here; a summary says how many songs, albums, and playlists take how much space, and how much
 * is still free. A download still coming says how far it got. Albums and playlists open their own
 * pages; a song plays.
 */
import type { DownloadedItem, LocalCopy, OfflineLibrary } from "@music/sdk/downloads";
import { targetKey } from "@music/sdk/downloads";
import { router } from "expo-router";
import { CircleArrowDown } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { openAlbum } from "@/components/browse/rows";
import { TrackDownloadGlyph } from "@/components/downloads/download-glyphs";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Row } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { useDownloadsLibrary } from "@/downloads";
import {
  DOWNLOADED_FILTERS,
  downloadedEmpty,
  downloadedLine,
  downloadedNote,
  downloadedSummary,
  downloadsFor,
} from "@/lib/downloaded";
import type { DownloadedFilter } from "@/lib/downloaded";
import { formatBytes } from "@/lib/format";

/** One row of the list: a download, or under Songs, one song on this phone. */
type Cell =
  | { readonly kind: "download"; readonly item: DownloadedItem }
  | { readonly kind: "song"; readonly copy: LocalCopy; readonly index: number };

/** A download: its cover, title, where it stands, and the space it takes. */
function DownloadedRow({ item }: { readonly item: DownloadedItem }) {
  const { playFrom } = usePlayList();
  const line = downloadedLine(item);
  // Empty until its first song arrives, so every row drops the trailing lane alike.
  const size = item.bytes > 0 ? formatBytes(item.bytes) : null;
  const { target } = item;

  const open = () => {
    if (target.kind === "album") openAlbum({ id: target.id });
    else if (target.kind === "playlist") {
      router.push({ pathname: "/playlist/[id]", params: { id: target.id } });
    } else playFrom([target.id], 0);
  };

  return (
    <View className="px-mobile-edge">
      <Row
        title={item.title}
        subtitle={line.text}
        subtitleTone={line.tone}
        subtitleGlyph={line.glyph === null ? undefined : <TrackDownloadGlyph state={line.glyph} />}
        leading={{ kind: "art", url: item.artUri, recyclingKey: targetKey(target) }}
        detail={{ text: size ?? "", variant: "mono" }}
        accessibilityLabel={[item.title, line.text, size]
          .filter((part) => part !== null)
          .join(", ")}
        onPress={open}
      />
    </View>
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
    <View className="px-mobile-edge">
      <ChipGroup label="Show" options={DOWNLOADED_FILTERS} value={filter} onChange={onFilter} />
      <View className="gap-2 pt-1 pb-3">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text variant="mono" tone="muted" className="shrink">
            {downloadedSummary(usage, downloads)}
          </Text>
          {usage.bytes === 0 ? null : <Text variant="mono">{formatBytes(usage.bytes)}</Text>}
        </View>
        <Text variant="secondary" tone="muted">
          {downloadedNote(usage)}
        </Text>
      </View>
    </View>
  );
}

export default function Downloaded() {
  const library = useDownloadsLibrary();
  const { downloads, songs } = library;
  const { playFrom } = usePlayList();
  const [filter, setFilter] = useState<DownloadedFilter>("all");
  const songIds = songs.map((copy) => copy.track.id);

  const cells: ReadonlyArray<Cell> =
    filter === "songs"
      ? songs.map((copy, index) => ({ kind: "song", copy, index }))
      : downloadsFor(filter, downloads).map((item) => ({ kind: "download", item }));

  return (
    <ListPage
      bar={{ title: "Downloaded" }}
      data={cells}
      keyExtractor={(cell) =>
        cell.kind === "song" ? cell.copy.track.id : targetKey(cell.item.target)
      }
      getItemType={(cell) => cell.kind}
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
        cell.kind === "song" ? (
          <View className="px-mobile-edge">
            <Row
              title={cell.copy.track.title}
              subtitle={cell.copy.track.artist}
              subtitleGlyph={<TrackDownloadGlyph state="downloaded" />}
              leading={{ kind: "art", url: cell.copy.artUri, recyclingKey: cell.copy.track.id }}
              detail={{ text: formatBytes(cell.copy.bytes), variant: "mono" }}
              onPress={() => playFrom(songIds, cell.index)}
            />
          </View>
        ) : (
          <DownloadedRow item={cell.item} />
        )
      }
    />
  );
}
