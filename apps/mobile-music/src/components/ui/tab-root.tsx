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

const COLLAPSE_AT = 44;

const STICKY_BAR = [0];

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
