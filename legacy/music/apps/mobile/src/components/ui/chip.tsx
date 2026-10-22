/**
 * Paper's segmented chips (Yours / Shared, sort chips, search filters): full-radius pills with
 * 13/18 semibold labels. The selected chip is the text color with inverse label; the others sit on
 * the surface. A group allows exactly one selection.
 */
import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, View } from "react-native";

import { Text } from "./text";

/** Props for `Chip`. */
interface ChipProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}

/** One selectable pill. */
function Chip({ label, selected, onPress }: ChipProps) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      className={`rounded-full px-4 py-2 active:opacity-70 ${selected ? "bg-text" : "bg-surface"}`}
    >
      <Text variant="secondaryStrong" tone={selected ? "inverse" : "default"}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One option of a chip group. */
interface ChipOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/** Props for `ChipGroup`. */
export interface ChipGroupProps<Value extends string> {
  readonly options: ReadonlyArray<ChipOption<Value>>;
  readonly value: Value;
  readonly onChange: (value: Value) => void;
  /** What VoiceOver calls the group, such as `Sort`. */
  readonly label: string;
  /**
   * False for a short group that always fits, such as Grid and List. Native form sheets sized to
   * their content misplace a sideways scroll view, so sheets use a plain row.
   */
  readonly scrolls?: boolean;
}

/** A single-select row of chips that scrolls sideways when it outgrows the screen. */
export function ChipGroup<Value extends string>({
  options,
  value,
  onChange,
  label,
  scrolls = true,
}: ChipGroupProps<Value>) {
  const chips = options.map((option) => (
    <Chip
      key={option.value}
      label={option.label}
      selected={option.value === value}
      onPress={() => {
        if (option.value === value) return;
        void Haptics.selectionAsync();
        onChange(option.value);
      }}
    />
  ));

  if (!scrolls) {
    return (
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        className="flex-row gap-2 py-3"
      >
        {chips}
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      contentContainerClassName="gap-2 py-3"
    >
      {chips}
    </ScrollView>
  );
}
