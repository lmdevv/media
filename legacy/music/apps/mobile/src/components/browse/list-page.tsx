/**
 * A pushed browse page whose content is a recycled list (A03–A08): Paper's back bar over a
 * FlashList. The bar floats over the list on the page color, and the list starts under it; the
 * list is the page's content, so scrolling it minimizes the tab bar. A page that draws its own
 * top, such as an artist's hero (A08b), passes no bar.
 */
import { FlashList } from "@shopify/flash-list";
import type { FlashListProps } from "@shopify/flash-list";
import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ContentScroll } from "@/components/ui/content-scroll";
import { NavBar } from "@/components/ui/nav-bar";
import type { NavBarProps } from "@/components/ui/nav-bar";

/** Paper's pushed bar under the status bar: 8 above a 44pt button, 12 below. Measured after. */
const BAR_HEIGHT = 64;

/** Props for `ListPage`. */
export interface ListPageProps<Item> extends Omit<
  FlashListProps<Item>,
  "ListHeaderComponent" | "ListFooterComponent"
> {
  /** Null for a page that draws its own top over the list. */
  readonly bar: NavBarProps | null;
  /** What scrolls above the rows, such as a summary line or an album's hero. */
  readonly header?: ReactNode;
  /** What scrolls below the rows, such as an empty state. */
  readonly footer?: ReactNode;
}

/** A pushed page of rows under Paper's back bar, with room for the tab bar below. */
export function ListPage<Item>({ bar, header, footer, ...list }: ListPageProps<Item>) {
  const insets = useSafeAreaInsets();
  const [measured, setBarHeight] = useState(insets.top + BAR_HEIGHT);
  const barHeight = bar === null ? 0 : measured;

  return (
    <ContentScroll>
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
            <View className="h-page-foot" />
          </>
        }
      />
      {bar === null ? null : (
        <View
          className="absolute inset-x-0 top-0"
          onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
        >
          <NavBar {...bar} />
        </View>
      )}
    </ContentScroll>
  );
}
