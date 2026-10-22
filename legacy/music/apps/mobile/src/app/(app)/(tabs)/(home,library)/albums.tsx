/**
 * A03 · Albums: every album, recently added first or A–Z by title or artist, as a two-column grid
 * or a list (A12 sets both; the chips change the order in place). A card opens the album (A07).
 * Pages load as the grid nears its end, or all at once for an order the server doesn't page in.
 */
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

/** Albums per page: a few screens of the grid. */
const PAGE_SIZE = 48;

/** The grid as rows of two cards, as Paper builds it. */
const rowsOfTwo = (albums: ReadonlyArray<Album>): ReadonlyArray<ReadonlyArray<Album>> =>
  Array.from({ length: Math.ceil(albums.length / 2) }, (_, row) =>
    albums.slice(row * 2, row * 2 + 2),
  );

/** One row of the grid: two cards 12pt apart, filling the page between its 20pt edges. */
function GridRow({ albums }: { readonly albums: ReadonlyArray<Album> }) {
  return (
    <View className="flex-row gap-3 px-mobile-edge pb-4">
      {albums.map((album) => (
        <View key={album.id} className="flex-1">
          <AlbumCard album={album} size="fill" />
        </View>
      ))}
      {albums.length === 1 ? <View className="flex-1" /> : null}
    </View>
  );
}

export default function Albums() {
  const { sort, layout } = useBrowseView().albums;
  const pages = useAlbumPages({ limit: PAGE_SIZE, all: !albumsArriveSorted(sort) });
  const albums = sortAlbums(pages.items, sort);
  const done = pages.status.kind === "done";

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
    <View className="px-mobile-edge">
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
      <View className="px-mobile-edge">
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
      data={rowsOfTwo(albums)}
      keyExtractor={(row) => row.map((album) => album.id).join()}
      onEndReached={pages.loadMore}
      onEndReachedThreshold={1}
      renderItem={({ item }) => <GridRow albums={item} />}
    />
  );
}
