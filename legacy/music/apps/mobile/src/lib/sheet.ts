import type { NativeStackNavigationOptions } from "expo-router";
import { useCSSVariable } from "uniwind";

import { useThemeColor } from "./theme-color";

/**
 * Screen options for a native form sheet. The system draws the scrim; the sheet takes Paper's
 * `--radius-sheet` corners and the page color (`--color-bg`, #121212 in dark).
 */
export const useSheetOptions = (): NativeStackNavigationOptions => {
  const background = useThemeColor("--color-bg");
  const radius = Number.parseFloat(String(useCSSVariable("--radius-sheet")));

  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,
    sheetCornerRadius: radius,
    contentStyle: { backgroundColor: background },
  };
};
