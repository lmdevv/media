import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";

/** Props for `CalmState`. */
export interface CalmStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  /** `top` for a state that fills the screen under a navigation row, `center` under content. */
  readonly placement?: "top" | "center";
}

/** A calm state with an optional way forward. */
export function CalmState({
  icon,
  title,
  description,
  actions,
  placement = "center",
}: CalmStateProps) {
  return (
    <View className={`flex-1 gap-4 px-5 ${placement === "top" ? "pt-38" : "justify-center"}`}>
      <View className="items-center gap-4 py-6">
        {icon === undefined ? null : (
          <View className="size-18 items-center justify-center rounded-pill bg-surface">
            <Icon icon={icon} size="badge" />
          </View>
        )}
        <Text variant="title" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text tone="muted" className="text-center">
            {description}
          </Text>
        )}
      </View>
      {actions === undefined ? null : <View className="mt-10 w-full gap-4">{actions}</View>}
    </View>
  );
}
