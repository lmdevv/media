/**
 * The chrome of a tab root (A01, A02 expanded; A14, A15 scrolled): a 34/40 heavy large title with
 * the account avatar (and an optional action), scrolling with the content, then once it has scrolled away a 44pt bar on the
 * page color with the centered 16/24 title and the avatar, and a short fade under it so rows slip
 * beneath rather than showing through. The scroll view is the page's content, so UIKit minimizes
 * the system tab bar and moves the mini player inline as the page scrolls.
 */
import { useRead } from "@music/sdk/react";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ReconnectingNotice } from "@/components/states/reconnecting";
import { clearOf } from "@/lib/color";
import { useThemeColor } from "@/lib/theme-color";

import { Avatar } from "./avatar";
import { ContentScroll } from "./content-scroll";
import { Text } from "./text";

/** How far the content scrolls before the large title is gone and the compact bar takes over. */
const COLLAPSE_AT = 44;

/** The compact bar is the scroll view's first child, and stays at the top. */
const STICKY_BAR = [0];

/** The account avatar; it opens Settings (F01) from every tab root. */
function AccountButton() {
  const me = useRead("account.me", {});

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      onPress={() => router.push("/settings")}
      className="active:opacity-60"
    >
      <Avatar name={me === undefined ? "" : (me.name ?? me.email)} />
    </Pressable>
  );
}

/**
 * The sticky top bar, a constant status bar inset plus 44pt so the content never jumps: the avatar
 * alone until collapsed, then the page color with the title, fading out just below. The large
 * title row starts under it, beside the avatar.
 */
function CompactBar({
  title,
  collapsed,
  action,
}: {
  readonly title: string;
  readonly collapsed: boolean;
  readonly action: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const canvas = useThemeColor("--color-canvas");

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
          <View className="absolute inset-0 bg-canvas" />
          <View className="absolute inset-x-0 top-full h-6">
            <LinearGradient colors={[canvas, clearOf(canvas)]} style={StyleSheet.absoluteFill} />
          </View>
        </Animated.View>
      ) : null}
      <View
        className="h-hit-target flex-row items-center justify-end gap-2 px-mobile-edge"
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
        {action}
        <AccountButton />
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
}

/** A tab's root page: large title and avatar, content on the 20pt edge, room for the tab bar. */
export function TabRoot({ title, children, action }: TabRootProps) {
  const [collapsed, setCollapsed] = useState(false);

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
        className="flex-1 bg-canvas"
        contentContainerClassName="pb-ios-180"
      >
        <CompactBar title={title} collapsed={collapsed} action={action} />
        <View className="-mt-hit-target min-h-row-touch flex-row items-center gap-2 px-mobile-edge pt-2 pb-3">
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
        <View className="px-mobile-edge">
          <ReconnectingNotice />
          {children}
        </View>
      </ScrollView>
    </ContentScroll>
  );
}
