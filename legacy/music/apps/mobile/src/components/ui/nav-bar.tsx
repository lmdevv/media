/**
 * Paper's pushed nav bar (pages 13, 17, 19): a 44pt back button, the title left-aligned right
 * after it at 22/28 heavy, and an optional 44pt trailing action. The native stack keeps its edge
 * swipe back; this bar only draws the chrome Paper asks for.
 */
import { router, useNavigation } from "expo-router";
import { useNavigationState } from "expo-router/react-navigation";
import { ChevronLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IconButton } from "./icon-button";
import { Text } from "./text";

/** Props for `NavBar`. */
export interface NavBarProps {
  /** The page title; empty on pages whose content carries it, such as an album. */
  readonly title?: string;
  /** A 44pt `IconButton`, such as the page's ellipsis menu. */
  readonly trailing?: ReactNode;
  /**
   * What Back does: pop by default (no Back on a stack's root), a replacement where the page is a
   * stack's root but Paper still draws Back (Connect goes to Welcome), or null for no Back at all.
   */
  readonly onBack?: (() => void) | null;
}

/** The top bar of a pushed page, under the status bar on the page's own background. */
export function NavBar({ title, trailing, onBack }: NavBarProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  // A visible page is the top of its stack, so a stack holding more than one route can pop it.
  // Read from the live state: `canGoBack()` answers from the state the page first rendered with,
  // which can predate the push (a page pushed on Home showed no Back). It still covers the root
  // of a stack presented over another, such as Now Playing's.
  const stacked = useNavigationState((state) => state.index > 0);

  const back =
    onBack === undefined && (stacked || navigation.canGoBack()) ? () => router.back() : onBack;

  return (
    <View style={{ paddingTop: insets.top }} className="bg-canvas">
      <View className="min-h-row-touch flex-row items-center px-mobile-edge pt-2 pb-3">
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
        {trailing === undefined ? null : <View className="size-hit-target">{trailing}</View>}
      </View>
    </View>
  );
}
