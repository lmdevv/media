import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

/** Props for `EmptyState`. */
export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  /**
   * `page` fills a screen of its own (C12, C20); `results` sits in Search's padded results, closer
   * under the title (E04).
   */
  readonly placement?: "page" | "results";
}

/** A centered empty state, in the readable column on an iPad. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  placement = "page",
}: EmptyStateProps) {
  return (
    <View
      className={`${placement === "page" ? "gap-4 px-5 pt-30 regular:px-0" : "gap-4 pt-14"} regular:w-full regular:max-w-readable regular:self-center`}
    >
      <View className="items-center gap-4 py-6">
        <View className="size-18 items-center justify-center rounded-pill bg-surface">
          <Icon icon={icon} size="badge" />
        </View>
        <Text variant="title" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text tone="muted" className="text-center">
            {description}
          </Text>
        )}
      </View>
      {action}
    </View>
  );
}
