import type { LucideIcon } from "lucide-react-native";
import { View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";

export interface NoticeProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body?: string;
  readonly className?: string;
}

/** An inline, non-interactive status or hint. */
export function Notice({ icon, title, body, className }: NoticeProps) {
  return (
    <View
      className={`flex-row items-start gap-3 rounded-lg bg-surface p-4 ${className ?? ""}`}
      accessible
      accessibilityLabel={body === undefined ? title : `${title}. ${body}`}
    >
      <Icon icon={icon} tone="muted" size="inline" />
      <View className="flex-1 gap-1">
        <Text variant="label">{title}</Text>
        {body === undefined ? null : (
          <Text variant="secondary" tone="muted">
            {body}
          </Text>
        )}
      </View>
    </View>
  );
}
