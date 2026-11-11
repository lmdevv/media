import { ChevronRight } from "lucide-react-native";
import type { ReactElement } from "react";
import { FlatList, Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

/** Props for `Rail`. */
export interface RailProps<Item> {
  readonly title: string;
  readonly items: ReadonlyArray<Item>;
  readonly keyOf: (item: Item) => string;
  readonly render: (item: Item) => ReactElement;
  /** A muted note beside the heading, such as `+12 so far`. */
  readonly note?: string;
  /** Makes the heading open the full list, with a chevron after it. */
  readonly onSeeAll?: () => void;
}

/** A heading and a sideways row; nothing when the row is empty. */
export function Rail<Item>({ title, items, keyOf, render, note, onSeeAll }: RailProps<Item>) {
  if (items.length === 0) return null;

  return (
    <View className="gap-4">
      {onSeeAll === undefined ? (
        <View className="flex-row items-baseline gap-2 px-5 regular:px-8 wide:px-12">
          <Text variant="heading" accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {note === undefined ? null : (
            <Text variant="meta" tone="muted">
              {note}
            </Text>
          )}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`All ${title}`}
          onPress={onSeeAll}
          className="flex-row items-center gap-1 self-start px-5 active:opacity-60 regular:px-8 wide:px-12"
        >
          <Text variant="heading" numberOfLines={1}>
            {title}
          </Text>
          <Icon icon={ChevronRight} tone="muted" size="inline" />
        </Pressable>
      )}
      <FlatList
        horizontal
        data={items}
        keyExtractor={keyOf}
        renderItem={({ item }) => render(item)}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 px-5 regular:gap-4 regular:px-8 wide:px-12"
      />
    </View>
  );
}
