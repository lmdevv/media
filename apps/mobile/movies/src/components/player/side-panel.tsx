import { X } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

/** Props for `SidePanel`. */
export interface SidePanelProps {
  readonly title: string;
  /** Width classes from the panel's artboard, such as `w-100` for F03's 400pt panel. */
  readonly widthClassName: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** A sheet on the right of the player. */
export function SidePanel({ title, widthClassName, onClose, children }: SidePanelProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="absolute inset-0">
      <Animated.View entering={FadeIn} exiting={FadeOut} className="absolute inset-0 bg-scrim">
        <Pressable
          className="flex-1"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      </Animated.View>
      <Animated.View
        entering={SlideInRight}
        exiting={SlideOutRight}
        className={`absolute top-0 right-0 bottom-0 bg-dark-surface-raised ${widthClassName}`}
        style={{ paddingRight: insets.right }}
        accessibilityViewIsModal
      >
        <View className="flex-1 gap-4 p-6">
          <View className="flex-row items-center">
            <Text
              variant="heading"
              className="flex-1"
              tone="onMedia"
              numberOfLines={1}
              accessibilityRole="header"
            >
              {title}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel="Close"
              className="size-9 items-center justify-center rounded-pill bg-dark-surface-raised/80 active:opacity-70"
            >
              <Icon icon={X} tone="onMedia" />
            </Pressable>
          </View>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
