/**
 * Paper's toggle row (D04, D08): a 72pt row with a title over a muted line and the 48×28 switch,
 * over a hairline.
 */
import { View } from "react-native";

import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

/** Props for `ToggleRow`. */
export interface ToggleRowProps {
  readonly title: string;
  readonly subtitle: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
}

/** A labeled on/off setting. */
export function ToggleRow({ title, subtitle, value, onValueChange, disabled }: ToggleRowProps) {
  return (
    <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
      <View className="flex-1 gap-1">
        <Text variant="bodyMedium">{title}</Text>
        <Text variant="secondary" tone="muted">
          {subtitle}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        label={title}
        {...(disabled === undefined ? {} : { disabled })}
      />
    </View>
  );
}
