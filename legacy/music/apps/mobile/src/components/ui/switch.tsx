/**
 * Paper's 48×28 switch: on is the text color with a page-colored knob at the end, so it reads in
 * both themes without the accent. Off is the hairline track with a muted knob at the start.
 */
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";

/** Props for `Switch`. */
export interface SwitchProps {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  /** What VoiceOver reads, such as `Autoplay`. */
  readonly label: string;
  readonly disabled?: boolean;
}

/** An on/off control that VoiceOver announces as a switch. */
export function Switch({ value, onValueChange, label, disabled = false }: SwitchProps) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        void Haptics.selectionAsync();
        onValueChange(!value);
      }}
      className={`h-ios-28 w-12 flex-row rounded-full p-1 active:opacity-80 ${
        value ? "justify-end bg-text" : "justify-start bg-border"
      } ${disabled ? "opacity-disabled" : ""}`}
    >
      <Animated.View
        layout={LinearTransition.duration(160)}
        className={`size-mobile-edge rounded-full ${value ? "bg-bg" : "bg-text-muted"}`}
      />
    </Pressable>
  );
}
