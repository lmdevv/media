import { useEffect } from "react";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { Text } from "./text";

const REMOVE_WIDTH = 104;

const FLICK_SPEED = 500;

const SETTLE = { duration: 220, dampingRatio: 1 } as const;

const SLOP = 10;

/** What a swipeable row's own press, hold, and VoiceOver action call. */
interface SwipeControls {
  /** Closes an open row and returns true, so the press does nothing else; false when closed. */
  readonly settle: () => boolean;
  /** Closes the row and removes it, as the uncovered Remove does. */
  readonly remove: () => void;
}

export interface SwipeToRemoveProps {
  /** Off for a copy of the row that can't be swiped, such as the queue's lifted row. */
  readonly enabled?: boolean;
  /**
   * On for a row on a screen that a rightward drag takes back: a closed row, which can't move
   * right, leaves that drag to the screen. Off, a closed row takes it, so it never counts as a tap.
   */
  readonly swipeBack?: boolean;
  /** What the row shows; a recycled row starts closed when it changes. */
  readonly resetKey: string;
  /** The color under the row, so it covers Remove until it slides aside. */
  readonly background: string;
  readonly onRemove: () => void;
  /** The row; its press calls `settle` first, and its other ways to remove call `remove`. */
  readonly children: (swipe: SwipeControls) => ReactNode;
}

/** A row that uncovers Remove when swiped left. VoiceOver can't swipe: give the row an action. */
export function SwipeToRemove({
  enabled = true,
  swipeBack = false,
  resetKey,
  background,
  onRemove,
  children,
}: SwipeToRemoveProps) {
  const offset = useSharedValue(0);
  const start = useSharedValue(0);
  const speed = useSharedValue(0);
  const closedLetGo = swipeBack ? SLOP : Number.POSITIVE_INFINITY;
  const letGoRight = useSharedValue(closedLetGo);

  useEffect(() => {
    offset.value = 0;
    letGoRight.value = closedLetGo;
  }, [offset, letGoRight, closedLetGo, resetKey]);

  const remove = () => {
    offset.value = 0;
    letGoRight.value = closedLetGo;
    onRemove();
  };

  const settle = (): boolean => {
    if (offset.value >= 0) return false;
    offset.value = withSpring(0, SETTLE);
    letGoRight.value = closedLetGo;

    return true;
  };

  const swipe = usePanGesture({
    enabled,
    activeOffsetX: [-SLOP, SLOP],
    failOffsetX: letGoRight,
    failOffsetY: [-SLOP, SLOP],
    onBegin: () => {
      "worklet";
      start.value = offset.value;
    },
    onUpdate: (event) => {
      "worklet";
      offset.value = Math.min(0, Math.max(-REMOVE_WIDTH, start.value + event.translationX));
      speed.value = event.velocityX;
    },
    onFinalize: () => {
      "worklet";

      const open =
        speed.value < -FLICK_SPEED ||
        (speed.value <= FLICK_SPEED && offset.value < -REMOVE_WIDTH / 2);

      speed.value = 0;
      offset.value = withSpring(open ? -REMOVE_WIDTH : 0, SETTLE);
      letGoRight.value = open ? Number.POSITIVE_INFINITY : closedLetGo;
    },
  });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const uncovered = useAnimatedStyle(() => ({ opacity: offset.value < 0 ? 1 : 0 }));

  return (
    <View>
      <Animated.View style={uncovered} className="absolute inset-y-0 right-0">
        <Pressable
          accessible={false}
          onPress={remove}
          className="h-full w-ios-104 items-center justify-center bg-danger active:opacity-80"
        >
          <Text variant="label" tone="onAccent">
            Remove
          </Text>
        </Pressable>
      </Animated.View>
      <GestureDetector gesture={swipe}>
        <Animated.View style={[slide, { backgroundColor: background }]}>
          {children({ settle, remove })}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
