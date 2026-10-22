/**
 * A pushed browse page whose content is a recycled list (A03–A08): Paper's back bar over a
 * FlashList. The list is the page's first child, where UIKit looks for the scroll view that
 * minimizes the tab bar; the bar floats over it on the page color, and the list starts under it.
 */
import { FlashList } from "@shopify/flash-list";
import type { FlashListProps } from "@shopify/flash-list";
import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NavBar } from "@/components/ui/nav-bar";
import type { NavBarProps } from "@/components/ui/nav-bar";

/** Paper's pushed bar under the status bar: 8 above a 44pt button, 12 below. Measured after. */
const BAR_HEIGHT = 64;

/** Props for `ListPage`. */
export interface ListPageProps<Item> extends Omit<
  FlashListProps<Item>,
  "ListHeaderComponent" | "ListFooterComponent"
> {
  readonly bar: NavBarProps;
  /** What scrolls above the rows, such as a summary line or an album's hero. */
  readonly header?: ReactNode;
  /** What scrolls below the rows, such as an empty state. */
  readonly footer?: ReactNode;
}

/** A pushed page of rows under Paper's back bar, with room for the tab bar below. */
export function ListPage<Item>({ bar, header, footer, ...list }: ListPageProps<Item>) {
  const insets = useSafeAreaInsets();
  const [barHeight, setBarHeight] = useState(insets.top + BAR_HEIGHT);

  return (
    <View className="flex-1 bg-canvas">
      <FlashList
        {...list}
        scrollIndicatorInsets={{ top: barHeight }}
        ListHeaderComponent={
          <>
            <View style={{ height: barHeight }} />
            {header}
          </>
        }
        ListFooterComponent={
          <>
            {footer}
            <View className="h-ios-180" />
          </>
        }
      />
      <View
        className="absolute inset-x-0 top-0"
        onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
      >
        <NavBar {...bar} />
      </View>
    </View>
  );
}
