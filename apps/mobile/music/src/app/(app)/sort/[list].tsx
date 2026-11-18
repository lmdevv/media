import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Library } from "lucide-react-native";

import { updateBrowseView, useBrowseView } from "@/components/browse/browse-view-store";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { Row, RowCheck } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { SORT_SHEETS, SortList } from "@/lib/browse-view";
import type { AlbumLayout, AlbumSort, SongSort } from "@/lib/browse-view";

const decodeList = Schema.decodeUnknownOption(SortList);

const LAYOUTS = [
  { value: "grid", label: "Grid" },
  { value: "list", label: "List" },
] as const satisfies ReadonlyArray<{ readonly value: AlbumLayout; readonly label: string }>;

function SortRow({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Row
      title={label}
      leading={{ kind: "icon", icon: Library }}
      trailing={selected ? <RowCheck /> : undefined}
      onPress={onPress}
      accessibilityLabel={selected ? `${label}, selected` : label}
    />
  );
}

const done = <Button label="Done" onPress={() => router.back()} />;

const setAlbums = (change: { readonly sort?: AlbumSort; readonly layout?: AlbumLayout }) => {
  updateBrowseView((view) => ({ ...view, albums: { ...view.albums, ...change } }));
};

const setSongSort = (sort: SongSort) => {
  updateBrowseView((view) => ({ ...view, songs: { sort } }));
};

function AlbumsSheet() {
  const { sort, layout } = useBrowseView().albums;

  return (
    <SheetLayout title="Sort and view" subtitle={SORT_SHEETS.albums.subtitle} actions={done}>
      {SORT_SHEETS.albums.sorts.map((option) => (
        <SortRow
          key={option.value}
          label={option.label}
          selected={option.value === sort}
          onPress={() => setAlbums({ sort: option.value })}
        />
      ))}
      <SectionHeader title="Layout" />
      <ChipGroup
        label="Layout"
        scrolls={false}
        options={LAYOUTS}
        value={layout}
        onChange={(next) => setAlbums({ layout: next })}
      />
    </SheetLayout>
  );
}

function SongsSheet() {
  const { sort } = useBrowseView().songs;

  return (
    <SheetLayout title="Sort and view" subtitle={SORT_SHEETS.songs.subtitle} actions={done}>
      {SORT_SHEETS.songs.sorts.map((option) => (
        <SortRow
          key={option.value}
          label={option.label}
          selected={option.value === sort}
          onPress={() => setSongSort(option.value)}
        />
      ))}
    </SheetLayout>
  );
}

export default function SortSheet() {
  const list = Option.getOrNull(decodeList(useLocalSearchParams().list));

  if (list === null) return <SheetLayout title="Sort and view" />;

  return list === "albums" ? <AlbumsSheet /> : <SongsSheet />;
}
