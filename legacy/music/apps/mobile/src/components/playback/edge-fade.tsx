import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";

import { clearOf } from "@/lib/color";

/**
 * The sheet's color fading a scrolling panel out at one edge, over the panel's content: 48pt at
 * the bottom, above the controls (B03, B12, B13), and 24pt at the top, under the lyrics caption
 * (B12), so a line scrolled half away never meets the caption with a hard edge. `background` is
 * the sheet's color.
 */
export function EdgeFade({
  edge,
  background,
}: {
  readonly edge: "top" | "bottom";
  readonly background: string;
}) {
  const clear = clearOf(background);

  return (
    <View
      className={`absolute inset-x-0 ${edge === "top" ? "top-0 h-6" : "bottom-0 h-12"}`}
      pointerEvents="none"
    >
      <LinearGradient
        colors={edge === "top" ? [background, clear] : [clear, background]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
