import { View } from "react-native";

/** Props for `ProgressBar`. */
export interface ProgressBarProps {
  /** From 0 to 1. */
  readonly value: number;
  /** Over artwork the track is translucent white instead of the hairline. */
  readonly overMedia?: boolean;
  readonly className?: string;
}

/** How far through something a profile is. */
export function ProgressBar({ value, overMedia = false, className }: ProgressBarProps) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      className={`h-1 w-full overflow-hidden rounded-pill ${overMedia ? "bg-video-track" : "bg-hairline"} ${className ?? ""}`}
    >
      <View className="h-full rounded-pill bg-accent" style={{ width: `${percent}%` }} />
    </View>
  );
}
