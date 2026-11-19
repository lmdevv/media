import type { NativeStackNavigationOptions } from "expo-router";
import { Platform } from "react-native";

import { useThemeColor } from "./theme-color";

/** iOS 26 draws form sheets in Liquid Glass, with corners that follow the screen's. */
const SYSTEM_GLASS = Platform.OS === "ios" && Number.parseInt(Platform.Version, 10) >= 26;

/**
 * Screen options for a native form sheet sized to its content. iOS 26 and later draw the sheet's
 * glass and corners, so the page under the content stays transparent; earlier versions fill it
 * with the page color (`--color-bg`).
 */
export const useSheetOptions = (): NativeStackNavigationOptions => {
  const background = useThemeColor("--color-bg");

  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,
    contentStyle: { backgroundColor: SYSTEM_GLASS ? "transparent" : background },
  };
};
