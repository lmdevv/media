import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encode } from "uqr";

import { useThemeColor } from "@/lib/theme-color";

/**
 * A QR code for `value`, in the theme's text on its background, encoded with `uqr` (MIT) at
 * medium error correction so a camera reads it off a screen; VoiceOver reads `label`.
 */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const ink = useThemeColor("--color-text");
  const paper = useThemeColor("--color-bg");

  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });

    const cells = qr.data.flatMap((row, y) =>
      row.flatMap((on, x) => (on ? [`M${String(x)} ${String(y)}h1v1h-1z`] : [])),
    );

    return { size: qr.size, path: cells.join("") };
  }, [value]);

  return (
    <View className="size-ios-192" accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg viewBox={`0 0 ${String(size)} ${String(size)}`} width="100%" height="100%">
        <Rect width={size} height={size} fill={paper} />
        <Path d={path} fill={ink} />
      </Svg>
    </View>
  );
}
