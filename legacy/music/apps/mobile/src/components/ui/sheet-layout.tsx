/**
 * The inside of Paper's bottom sheets, for routes presented as native form sheets (the system
 * draws the grabber, the scrim, and the 28pt corners): a 22/28 heavy title with a 44pt close
 * button, an optional 14/20 muted subtitle, the body, and the actions stacked under it.
 */
import { router } from "expo-router";
import { X } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { IconButton } from "./icon-button";
import { Text } from "./text";

/** Props for `SheetLayout`. */
export interface SheetLayoutProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children?: ReactNode;
  /** `Button`s, stacked 8pt apart under the body. */
  readonly actions?: ReactNode;
}

/** A sheet's title row, body, and actions; Close dismisses the sheet. */
export function SheetLayout({ title, subtitle, children, actions }: SheetLayoutProps) {
  return (
    <View className="px-6 pt-6 pb-8">
      <View className="flex-row items-center justify-between gap-3 pb-3">
        <Text variant="section" accessibilityRole="header" className="flex-1">
          {title}
        </Text>
        <IconButton icon={X} label="Close" onPress={() => router.back()} />
      </View>
      {subtitle === undefined ? null : (
        <Text variant="callout" tone="muted" className="pb-4">
          {subtitle}
        </Text>
      )}
      {children}
      {actions === undefined ? null : <View className="gap-2 pt-2">{actions}</View>}
    </View>
  );
}
