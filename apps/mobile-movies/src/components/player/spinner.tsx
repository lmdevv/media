import { LoaderCircle } from "lucide-react-native";
import { useEffect } from "react";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { Icon } from "@/components/ui/icon";

const TURN_MS = 1_000;

/** A turning loader in white over video. */
export function Spinner() {
  const turn = useSharedValue(0);

  useEffect(() => {
    turn.value = withRepeat(withTiming(360, { duration: TURN_MS, easing: Easing.linear }), -1);

    return () => {
      cancelAnimation(turn);
    };
  }, [turn]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${String(turn.value)}deg` }] }));

  return (
    <Animated.View style={style} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <Icon icon={LoaderCircle} tone="onMedia" size="control" />
    </Animated.View>
  );
}
