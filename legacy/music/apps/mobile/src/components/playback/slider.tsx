/**
 * Paper's thumbless 4pt track (B01's scrubber and volume): drag anywhere along it to move the
 * value by the distance dragged, as iOS Music does. The drag claims the touch at once, so a
 * vertical wobble on the track never pulls the Now Playing sheet down (B11). The value changes
 * on release; `onScrub` reports it live, for a label that follows the finger.
 */
import { useEffect } from "react";
import { View } from "react-native";
import type { AccessibilityActionEvent } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** How long a released value holds before the player's reports take over again. */
const SETTLE_MS = 1200;

/** How far one VoiceOver swipe moves the value. */
const STEP = 0.05;

/** Props for `Slider`. */
export interface SliderProps {
  /** From 0 to 1, as the player reports it. */
  readonly value: number;
  /** Called on release with the new value, from 0 to 1. */
  readonly onChange: (value: number) => void;
  /** Called while dragging with the value under the finger, and with null on release. */
  readonly onScrub?: (value: number | null) => void;
  /** The fill's color class: `bg-text` for the scrubber, `bg-text-muted` for volume. */
  readonly fillClassName: string;
  /** What VoiceOver calls the slider, such as `Position`. */
  readonly label: string;
  /** What VoiceOver reads as the value, such as `2:18 of 5:08`. */
  readonly valueText: string;
}

const clamp = (value: number): number => {
  "worklet";

  return Math.min(1, Math.max(0, value));
};

/** A horizontal track with a fill and a 44pt touch area. */
export function Slider({ value, onChange, onScrub, fillClassName, label, valueText }: SliderProps) {
  const width = useSharedValue(0);
  const shown = useSharedValue(clamp(value));
  const start = useSharedValue(0);
  const dragging = useSharedValue(false);
  const releasedAt = useSharedValue(0);

  useEffect(() => {
    const settled = Date.now() - releasedAt.value > SETTLE_MS;

    if (!dragging.value && settled) shown.value = clamp(value);
  }, [value, dragging, releasedAt, shown]);

  const report = (next: number | null) => {
    onScrub?.(next);
  };

  const release = (next: number) => {
    onScrub?.(null);
    onChange(next);
  };

  const pan = usePanGesture({
    minDistance: 0,
    shouldCancelWhenOutside: false,
    onBegin: () => {
      "worklet";
      dragging.value = true;
      start.value = shown.value;
      scheduleOnRN(report, shown.value);
    },
    onUpdate: (event) => {
      "worklet";

      if (width.value <= 0) return;
      shown.value = clamp(start.value + event.translationX / width.value);
      scheduleOnRN(report, shown.value);
    },
    onDeactivate: () => {
      "worklet";
      releasedAt.value = Date.now();
      scheduleOnRN(release, shown.value);
    },
    onFinalize: () => {
      "worklet";

      if (dragging.value) scheduleOnRN(report, null);
      dragging.value = false;
    },
  });

  const fill = useAnimatedStyle(() => ({ width: `${shown.value * 100}%` }));

  const track = useAnimatedStyle(() => ({
    transform: [{ scaleY: withTiming(dragging.value ? 2 : 1, { duration: 120 }) }],
  }));

  const adjust = (event: AccessibilityActionEvent) => {
    const step = event.nativeEvent.actionName === "increment" ? STEP : -STEP;
    const next = clamp(shown.value + step);
    shown.value = next;
    releasedAt.value = Date.now();
    onChange(next);
  };

  return (
    <GestureDetector gesture={pan}>
      <View
        className="h-hit-target justify-center"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={adjust}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
        }}
      >
        <Animated.View style={track} className="h-1 overflow-hidden rounded-full bg-border">
          <Animated.View style={fill} className={`h-full rounded-full ${fillClassName}`} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
