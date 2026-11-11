import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { KIND_FILTERS } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";

/** Props for `Chip`. */
export interface ChipProps {
  readonly label: string;
  readonly selected?: boolean;
  /** Draws the selected fill without meaning selection, such as the Genres chip over a hero. */
  readonly prominent?: boolean;
  readonly onPress: () => void;
  /** What VoiceOver reads when the label alone is not enough, such as `Filter by library`. */
  readonly accessibilityLabel?: string;
}

/** A filter or genre pill. */
export function Chip({
  label,
  selected = false,
  prominent = false,
  onPress,
  accessibilityLabel,
}: ChipProps) {
  const filled = selected || prominent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      hitSlop={4}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={`h-9 flex-row items-center rounded-pill px-4 active:opacity-70 ${
        filled ? "bg-text" : "bg-surface"
      }`}
    >
      <Text variant="labelStrong" tone={filled ? "inverse" : "default"} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The All, Movies, and Shows chips. */
export function KindChips({
  kind,
  onChange,
}: {
  readonly kind: KindFilter;
  readonly onChange: (kind: KindFilter) => void;
}) {
  return (
    <View className="flex-row gap-2">
      {KIND_FILTERS.map((filter) => (
        <Chip
          key={filter.kind}
          label={filter.label}
          selected={kind === filter.kind}
          onPress={() => onChange(filter.kind)}
        />
      ))}
    </View>
  );
}
