/** F19's progress bar: an 8pt hairline-colored track with an accent fill. */
import { View } from "react-native";

/** Props for `ProgressBar`. */
export interface ProgressBarProps {
  /** How full the bar is, from 0 to 100. */
  readonly percent: number;
  /** What VoiceOver calls the bar, such as the library being scanned. */
  readonly label: string;
}

/** A determinate progress bar that VoiceOver reads as a percentage. */
export function ProgressBar({ percent, label }: ProgressBarProps) {
  return (
    <View
      className="h-2 overflow-hidden rounded-full bg-border"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <View className="h-2 rounded-full bg-accent" style={{ width: `${String(percent)}%` }} />
    </View>
  );
}
