import type { WidthClass } from "@/lib/layout";

/**
 * Clearance under tab content for the floating tab bar, in points. A regular or wide window puts
 * the tab bar at the top, so only a compact one, an iPhone or a narrow iPad window, needs it.
 */
export const TAB_BAR_CLEARANCE: Readonly<Record<WidthClass, number>> = {
  compact: 96,
  regular: 0,
  wide: 0,
};
