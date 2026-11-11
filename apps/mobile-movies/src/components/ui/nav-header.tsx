import { router } from "expo-router";
import type { Href } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { IconButton } from "./icon-button";
import { Text } from "./text";

/** Props for `NavHeader`. */
export interface NavHeaderProps {
  readonly title?: string | undefined;
  /** Overrides going back, such as closing a flow. */
  readonly onBack?: (() => void) | undefined;
  /**
   * Where back goes when nothing is under this screen, such as after the app reopens on it;
   * `/` by default.
   */
  readonly fallback?: Href;
  /** Hides the back button on the first screen of a stack. */
  readonly back?: boolean;
  readonly trailing?: ReactNode;
}

/** A back button and a title, inset by the `Screen` it heads. */
export function NavHeader({
  title,
  onBack,
  fallback = "/",
  back = true,
  trailing,
}: NavHeaderProps) {
  return (
    <View className="h-16 flex-row items-center gap-3">
      {back ? (
        <IconButton
          icon={ChevronLeft}
          label="Back"
          onPress={
            onBack ?? (() => (router.canGoBack() ? router.back() : router.replace(fallback)))
          }
        />
      ) : null}
      {title === undefined ? (
        <View className="flex-1" />
      ) : (
        <Text variant="navTitle" className="flex-1" numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
      )}
      {trailing}
    </View>
  );
}
