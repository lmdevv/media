import { useCSSVariable } from "uniwind";

import { useThemeColor } from "./theme-color";
import { useWidthClass } from "./use-width-class";

/**
 * Screen options for a native form sheet: the grabber, the height of its content, the
 * `--radius-sheet` corners, and the raised surface behind it. An iPad window shows the sheet as a
 * centered card, which has nothing to drag, so only a compact window gets the grabber.
 */
export const useSheetOptions = () => {
  const surface = useThemeColor("--color-surface-raised");
  const compact = useWidthClass() === "compact";
  // Native sheets take the radius in points; the token is `28px`.
  const radius = Number.parseFloat(String(useCSSVariable("--radius-sheet")));

  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: compact,
    sheetCornerRadius: radius,
    contentStyle: { backgroundColor: surface },
  } as const;
};
