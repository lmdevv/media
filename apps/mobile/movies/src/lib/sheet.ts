import { isLiquidGlassAvailable } from "expo-glass-effect";

import { useThemeColor } from "./theme-color";
import { useWidthClass } from "./use-width-class";

/** Liquid Glass systems draw form sheets in glass, with corners that follow the screen's. */
const SYSTEM_GLASS = isLiquidGlassAvailable();

/**
 * Screen options for a native form sheet sized to its content. With Liquid Glass the system draws
 * the sheet's glass and corners, so the page under the content stays transparent; without it, the
 * page takes the raised surface. An iPad window shows the sheet as a centered card, which has
 * nothing to drag, so only a compact window gets the grabber.
 */
export const useSheetOptions = () => {
  const surface = useThemeColor("--color-surface-raised");
  const compact = useWidthClass() === "compact";

  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: compact,
    contentStyle: { backgroundColor: SYSTEM_GLASS ? "transparent" : surface },
  } as const;
};
