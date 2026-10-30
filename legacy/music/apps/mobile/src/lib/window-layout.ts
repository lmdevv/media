/** The window's layout from Paper's breakpoints, for what a class can't change, such as columns. */
import { useWindowDimensions } from "react-native";

import { widthClassOf } from "./layout";
import type { WidthClass } from "./layout";
import { useThemeLength } from "./theme-color";

/** The window's width in points, its layout, and the page's side margin there. */
export interface WindowLayout {
  readonly width: number;
  readonly widthClass: WidthClass;
  readonly edge: number;
}

/** The current window's layout; it changes as the iPad rotates or the app resizes in Split View. */
export const useWindowLayout = (): WindowLayout => {
  const { width } = useWindowDimensions();
  const tablet = useThemeLength("--breakpoint-tablet");
  const wide = useThemeLength("--breakpoint-wide");
  const phoneEdge = useThemeLength("--spacing-mobile-edge");
  const tabletEdge = useThemeLength("--spacing-tablet-edge");
  const widthClass = widthClassOf(width, { tablet, wide });

  return { width, widthClass, edge: widthClass === "phone" ? phoneEdge : tabletEdge };
};
