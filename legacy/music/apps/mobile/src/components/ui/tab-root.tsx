/**
 * The chrome of a tab root (A01, A02 expanded; A14, A15 scrolled): a 34/40 heavy large title with
 * the account avatar (and an optional action), scrolling with the content, then once it has scrolled away a 44pt bar on the
 * page color with the centered 16/24 title and the avatar, and a short fade under it so rows slip
 * beneath rather than showing through. The scroll view is the page's content, so UIKit minimizes
 * the system tab bar and moves the mini player inline as the page scrolls.
 *
 * On an iPad the sidebar takes over the avatar's job. Beside a pinned sidebar (A1) the page has no
 * bar at all, only the title and its figures. With the sidebar hidden (A3) the bar keeps the
 * button that shows it, Search, and the avatar, above the title rather than beside it.
 */
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSidebarControl } from "@/components/shell/sidebar-control";
import type { SidebarControl } from "@/components/shell/sidebar-control";
import { SearchButton, ShowSidebarButton } from "@/components/shell/top-buttons";
import { clearOf } from "@/lib/color";
import { useContentCanvas } from "@/lib/window-layout";

import { AccountButton } from "./account-button";
import { ContentScroll } from "./content-scroll";
import { Text } from "./text";

/** How far the content scrolls before the large title is gone and the compact bar takes over. */
const COLLAPSE_AT = 44;

/** The compact bar is the scroll view's first child, and stays at the top. */
const STICKY_BAR = [0];

/**
 * The sticky top bar, a constant status bar inset plus 44pt so the content never jumps: the avatar
 * alone until collapsed, then the page color with the title, fading out just below. On a phone
 * the large title row starts under it, beside the avatar.
 */
function CompactBar({
  title,
  collapsed,
  action,
  sidebar,
}: {
  readonly title: string;
  readonly collapsed: boolean;
  readonly action: ReactNode;
  readonly sidebar: SidebarControl | null;
}) {
  const insets = useSafeAreaInsets();
  const canvas = useContentCanvas();

  return (
    // A sticky header wraps its child, so `pointerEvents` goes in the style, where the wrapper
    // picks it up: touches outside the avatar reach the large title row and content under it.
    <View style={{ paddingTop: insets.top, pointerEvents: "box-none" }}>
      {collapsed ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <View className="absolute inset-0 bg-content" />
          <View className="absolute inset-x-0 top-full h-6">
            <LinearGradient colors={[canvas, clearOf(canvas)]} style={StyleSheet.absoluteFill} />
          </View>
        </Animated.View>
      ) : null}
      <View
        className="h-hit-target flex-row items-center justify-end gap-2 px-page"
        pointerEvents="box-none"
      >
        {collapsed ? (
          <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(120)}
            className="absolute inset-x-0 items-center"
            pointerEvents="none"
          >
            <Text variant="bodyStrong" numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
          </Animated.View>
        ) : null}
        {sidebar === null ? null : (
          <>
            <View className="mr-auto">
              <ShowSidebarButton onPress={sidebar.toggle} />
            </View>
            <SearchButton />
          </>
        )}
        {action}
        <AccountButton solid={sidebar !== null} />
      </View>
    </View>
  );
}

/** Props for `TabRoot`. */
export interface TabRootProps {
  readonly title: string;
  readonly children: ReactNode;
  /** A 44pt `IconButton` before the avatar, such as Playlists' New playlist (C01). */
  readonly action?: ReactNode;
  /** The figures across from an iPad's title, such as Home's totals (A1). */
  readonly figures?: string | undefined;
}

/** A tab's root page: large title and avatar, content on the 20pt edge, room for the tab bar. */
export function TabRoot({ title, children, action, figures }: TabRootProps) {
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = useSidebarControl();
  const beside = sidebar?.placement === "beside";

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > COLLAPSE_AT;

    if (next !== collapsed) setCollapsed(next);
  };

  return (
    <ContentScroll>
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        stickyHeaderIndices={STICKY_BAR}
        contentInsetAdjustmentBehavior="never"
        className="flex-1 bg-content"
        contentContainerClassName="pb-page-foot"
      >
        {/* Empty but the same height beside the sidebar: a sticky child only repositions on a scroll
            event, so if the bar's height changed, hiding the sidebar on a scrolled page would lose it. */}
        {beside ? (
          <View className="h-hit-target" style={{ pointerEvents: "box-none" }} />
        ) : (
          <CompactBar title={title} collapsed={collapsed} action={action} sidebar={sidebar} />
        )}
        {sidebar === null ? (
          <View className="-mt-hit-target min-h-row-touch flex-row items-center gap-2 px-page pt-2 pb-3">
            <Text
              variant="largeTitle"
              numberOfLines={1}
              accessibilityRole="header"
              className="flex-1"
            >
              {title}
            </Text>
            {/* The avatar and action stay in the bar above, so they are always on top to be tapped. */}
            {action === undefined ? null : <View className="size-hit-target" />}
            <View className="size-row" />
          </View>
        ) : (
          <View
            className={`flex-row items-end gap-2 px-page pt-4 pb-3 ${beside ? "-mt-hit-target" : ""}`}
          >
            <Text
              variant="largeTitle"
              numberOfLines={1}
              accessibilityRole="header"
              className="flex-1"
            >
              {title}
            </Text>
            {figures === undefined ? null : (
              <Text variant="mono" tone="muted" numberOfLines={1}>
                {figures}
              </Text>
            )}
            {beside ? action : null}
          </View>
        )}
        <View className="px-page">{children}</View>
      </ScrollView>
    </ContentScroll>
  );
}
