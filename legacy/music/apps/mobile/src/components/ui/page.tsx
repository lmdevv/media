/**
 * A pushed page: the nav bar stuck to the top of a scroll view that is the page's content, so the
 * system tab bar minimizes as the page scrolls. Content sits on Paper's 20pt edge.
 */
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { ContentScroll } from "./content-scroll";
import { NavBar } from "./nav-bar";
import type { NavBarProps } from "./nav-bar";

/** The nav bar is the scroll view's first child, and stays at the top. */
const STICKY_BAR = [0];

/** Props for `Page`. */
export interface PageProps extends NavBarProps {
  readonly children: ReactNode;
  /**
   * `tabs` leaves Paper's 180pt under the content for the tab bar and mini player; `plain` leaves
   * 40pt on pages pushed over the tabs (settings, Jams, entry), which hold settings and forms and
   * so on an iPad keep the bar and content on a centered readable column (P10).
   */
  readonly bottom?: "tabs" | "plain";
}

/** A scrolling pushed page with Paper's nav bar. */
export function Page({ children, bottom = "tabs", ...bar }: PageProps) {
  const readable = bottom === "plain";

  return (
    <ContentScroll>
      <ScrollView
        stickyHeaderIndices={STICKY_BAR}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        className="flex-1 bg-canvas"
        contentContainerClassName={readable ? "pb-row" : "pb-ios-180"}
      >
        <NavBar {...bar} readable={readable} />
        <View className="px-page">
          {readable ? <View className="readable">{children}</View> : children}
        </View>
      </ScrollView>
    </ContentScroll>
  );
}
