import type { TitleCard } from "@media/contracts/models/catalog";
import type { ReactElement } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { gridRows } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useGridLayout } from "@/lib/use-width-class";

import { TitlePoster } from "../title-poster";
import type { TitlePages } from "./title-pages";

/** Props for `PosterGrid`. */
export interface PosterGridProps {
  readonly titles: ReadonlyArray<TitleCard>;
  readonly header?: ReactElement | undefined;
  readonly footer?: ReactElement | undefined;
  readonly empty?: ReactElement | undefined;
  readonly onEndReached?: (() => void) | undefined;
}

/** A scrolling grid of posters, with as many columns as the window's width holds. */
export function PosterGrid({ titles, header, footer, empty, onEndReached }: PosterGridProps) {
  const insets = useSafeAreaInsets();
  const { columns, spacing } = useGridLayout();

  return (
    // One item per row, so a new column count reflows the rows without remounting the list and
    // losing its place when the window turns.
    <FlatList
      data={gridRows(titles, columns)}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => (
        <View className="flex-row" style={{ gap: spacing.gap, paddingHorizontal: spacing.gutter }}>
          {item.cells.map((cell) =>
            cell.kind === "title" ? (
              <TitlePoster
                key={cell.title.id}
                title={cell.title}
                caption="grid"
                widthClassName="flex-1"
              />
            ) : (
              <View key={cell.key} className="flex-1" />
            ),
          )}
        </View>
      )}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      ListFooterComponentClassName="pb-6"
      contentContainerClassName="gap-5 pt-2"
      contentContainerStyle={{ paddingBottom: insets.bottom }}
      contentInsetAdjustmentBehavior="automatic"
      onEndReached={onEndReached}
      onEndReachedThreshold={1}
    />
  );
}

/**
 * The end of a paged grid: a spinner while more pages load, or why the next page failed with Try
 * Again once some titles are on screen.
 */
export function PagingFooter({ pages }: { readonly pages: TitlePages }) {
  if (pages.failure !== null && pages.titles.length > 0) {
    return (
      <View className="items-center gap-3 px-5 pt-4 regular:px-8 wide:px-12">
        <Text variant="meta" tone="danger" className="text-center">
          {describeFailure(pages.failure.cause)}
        </Text>
        <Button
          label="Try Again"
          variant="secondary"
          className="self-stretch"
          onPress={pages.retry}
        />
      </View>
    );
  }

  if (pages.loaded && !pages.complete) {
    return <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />;
  }

  return <View />;
}
