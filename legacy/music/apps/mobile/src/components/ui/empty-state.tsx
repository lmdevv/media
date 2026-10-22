/**
 * Paper's empty-state block (page 19): a 64pt muted outline icon, a 28/32 heavy title, a 16/24
 * muted body, all centered, then a full-width primary action and an optional secondary one.
 */
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";

/** Props for `EmptyState`. */
export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
  /** A primary `Button`. */
  readonly primary?: ReactNode;
  /** A secondary `Button` under the primary one. */
  readonly secondary?: ReactNode;
  /** Page 19's state block (`state`), or the taller hero of page 16's Jam states (`hero`). */
  readonly spacing?: "state" | "hero";
}

/** A centered explanation of why a screen has nothing yet, and what to do about it. */
export function EmptyState({
  icon,
  title,
  body,
  primary,
  secondary,
  spacing = "state",
}: EmptyStateProps) {
  return (
    <View>
      <View
        className={`items-center gap-mobile-edge px-4 ${spacing === "hero" ? "py-ios-80" : "pt-16 pb-8"}`}
      >
        <Icon icon={icon} tone="muted" size="state" />
        <Text variant="title" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        <Text tone="muted" className="text-center">
          {body}
        </Text>
      </View>
      {primary}
      {secondary === undefined ? null : <View className="pt-3">{secondary}</View>}
    </View>
  );
}
