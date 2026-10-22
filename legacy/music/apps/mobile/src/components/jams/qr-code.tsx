/**
 * The Jam link's QR code (D02, H09): Paper's 192pt square, in the text color on the page color,
 * so it inverts in dark mode like Paper draws it.
 */
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { qrPath } from "@/lib/qr";
import { useThemeColor } from "@/lib/theme-color";

/** A QR code for `value`; VoiceOver reads `label`. */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const ink = useThemeColor("--color-text");
  const paper = useThemeColor("--color-bg");
  const { size, path } = qrPath(value);

  return (
    <View className="size-ios-192" accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg viewBox={`0 0 ${String(size)} ${String(size)}`} width="100%" height="100%">
        <Rect width={size} height={size} fill={paper} />
        <Path d={path} fill={ink} />
      </Svg>
    </View>
  );
}
