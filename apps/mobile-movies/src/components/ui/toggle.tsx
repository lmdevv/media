import { Switch, View } from "react-native";

import { useThemeColor } from "@/lib/theme-color";

/** Props for `Toggle`. */
export interface ToggleProps {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  /** What VoiceOver reads, such as `Kids Profile`. */
  readonly label: string;
  readonly disabled?: boolean;
}

/** An on/off switch. */
export function Toggle({ value, onValueChange, label, disabled = false }: ToggleProps) {
  const off = useThemeColor("--color-hairline");
  const on = useThemeColor("--color-accent");
  const thumb = useThemeColor("--color-on-accent");

  // Fabric lays the bare switch out at the top of a centered row; a sized box keeps it centered.
  return (
    <View className="h-8 justify-center">
      <Switch
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        disabled={disabled}
        trackColor={{ false: off, true: on }}
        ios_backgroundColor={off}
        thumbColor={thumb}
      />
    </View>
  );
}
