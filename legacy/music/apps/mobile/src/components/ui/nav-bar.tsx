import { router, useNavigation } from "expo-router";
import { useNavigationState } from "expo-router/react-navigation";
import { ChevronLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSidebarControl } from "@/components/shell/sidebar-control";
import { ShowSidebarButton } from "@/components/shell/top-buttons";
import { usePageBackground } from "@/lib/window-layout";

import { IconButton } from "./icon-button";
import { Text } from "./text";

export interface NavBarProps {
  /** The page title; empty on pages whose content carries it, such as an album. */
  readonly title?: string;
  /**
   * 44pt `IconButton`s, such as the page's ellipsis menu, side by side with no gap (an album's
   * download ring sits right before its ellipsis).
   */
  readonly trailing?: ReactNode;
  /**
   * What Back does: pop by default (no Back on a stack's root), a replacement where the page is a
   * stack's root but Paper still draws Back (Connect goes to Welcome), or null for no Back at all.
   */
  readonly onBack?: (() => void) | null;
}

/**
 * The top bar of a pushed page, under the status bar on the page's own background. A `readable`
 * bar, over settings and forms, keeps its row on their centered column on an iPad (P10).
 */
export function NavBar({
  title,
  trailing,
  onBack,
  readable = false,
}: NavBarProps & { readonly readable?: boolean }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const stacked = useNavigationState((state) => state.index > 0);
  const background = usePageBackground();
  const sidebar = useSidebarControl();

  const back =
    onBack === undefined && (stacked || navigation.canGoBack()) ? () => router.back() : onBack;

  return (
    <View
      style={{ paddingTop: insets.top }}
      className={`px-page ${readable ? "bg-canvas" : background}`}
    >
      <View
        className={`min-h-row-touch flex-row items-center pt-2 pb-3 ${
          readable ? "w-full self-center tablet:max-w-readable" : ""
        }`}
      >
        {sidebar?.placement === "hidden" ? (
          <View className="mr-2">
            <ShowSidebarButton onPress={sidebar.toggle} />
          </View>
        ) : null}
        {back === null || back === undefined ? null : (
          <IconButton icon={ChevronLeft} label="Back" onPress={back} />
        )}
        <Text
          variant="navTitle"
          numberOfLines={1}
          accessibilityRole="header"
          className={`flex-1 ${back === null || back === undefined ? "py-2" : ""}`}
        >
          {title ?? ""}
        </Text>
        {trailing === undefined ? null : (
          <View className="min-h-hit-target min-w-hit-target flex-row">{trailing}</View>
        )}
      </View>
    </View>
  );
}
