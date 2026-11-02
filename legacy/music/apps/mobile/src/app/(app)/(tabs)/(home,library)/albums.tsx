import type { AlbumCard as Album } from "@music/commands/models";
import { router } from "expo-router";
import { Ellipsis, Library } from "lucide-react-native";
import { View } from "react-native";

import { AlbumCard } from "@/components/browse/album-card";
import { updateBrowseView, useBrowseView } from "@/components/browse/browse-view-store";
import { ListPage } from "@/components/browse/list-page";
import { AlbumRow } from "@/components/browse/rows";
import { useAlbumPages } from "@/components/browse/use-pages";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { SORT_SHEETS, albumsArriveSorted, sortAlbums } from "@/lib/browse-view";
import { columnsOf, rowsOf } from "@/lib/layout";
import { useThemeLength } from "@/lib/theme-color";
import { useContentLayout } from "@/lib/window-layout";

const PAGE_SIZE = 48;

const MIN_COLUMNS = 2;

const useGridColumns = (): number => {
  const { width, widthClass, edge } = useContentLayout();
  const card = useThemeLength("--spacing-ios-168");
  const phoneGap = useThemeLength("--spacing-3");
  const tabletGap = useThemeLength("--spacing-4");
  const gap = widthClass === "phone" ? phoneGap : tabletGap;

  return Math.max(MIN_COLUMNS, columnsOf(width - 2 * edge, card, gap));
};

function GridRow({
  albums,
  columns,
}: {
  readonly albums: ReadonlyArray<Album>;
  readonly columns: number;
}) {
  return (
    <View className="flex-row gap-3 px-page pb-4 tablet:gap-4">
      {albums.map((album) => (
        <View key={album.id} className="flex-1">
          <AlbumCard album={album} size="fill" />
        </View>
      ))}
      {Array.from({ length: columns - albums.length }, (_, slot) => (
        <View key={slot} className="flex-1" />
      ))}
    </View>
  );
}

export default function Albums() {
  const { sort, layout } = useBrowseView().albums;
  const pages = useAlbumPages({ limit: PAGE_SIZE, all: !albumsArriveSorted(sort) });
  const albums = sortAlbums(pages.items, sort);
  const done = pages.status.kind === "done";
  const columns = useGridColumns();

  const bar = {
    title: "Albums",
    trailing: (
      <IconButton
        icon={Ellipsis}
        label="Sort and view"
        onPress={() => router.push({ pathname: "/sort/[list]", params: { list: "albums" } })}
      />
    ),
  };

  const header = (
    <View className="px-page">
      <ChipGroup
        label="Sort"
        options={SORT_SHEETS.albums.sorts}
        value={sort}
        onChange={(next) =>
          updateBrowseView((view) => ({ ...view, albums: { ...view.albums, sort: next } }))
        }
      />
    </View>
  );

  const footer =
    done && albums.length === 0 ? (
      <View className="px-page">
        <EmptyState
          icon={Library}
          title={"No albums\nyet."}
          body={"Albums show up here once\na library has been scanned."}
        />
      </View>
    ) : null;

  if (layout === "list") {
    return (
      <ListPage
        key="list"
        bar={bar}
        header={header}
        footer={footer}
        data={albums}
        keyExtractor={(album) => album.id}
        onEndReached={pages.loadMore}
        onEndReachedThreshold={1}
        renderItem={({ item }) => <AlbumRow album={item} />}
      />
    );
  }

  return (
    <ListPage
      key="grid"
      bar={bar}
      header={header}
      footer={footer}
      data={rowsOf(albums, columns)}
      keyExtractor={(row) => row.map((album) => album.id).join()}
      onEndReached={pages.loadMore}
      onEndReachedThreshold={1}
      renderItem={({ item }) => <GridRow albums={item} columns={columns} />}
    />
  );
}
