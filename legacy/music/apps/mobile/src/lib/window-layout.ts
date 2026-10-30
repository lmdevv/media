/** The window's layout from Paper's breakpoints, for what a class can't change, such as columns. */
import { useWindowDimensions } from "react-native";

import { widthClassOf } from "./layout";
import type { WidthClass } from "./layout";
import { useThemeLength } from "./theme-color";

/** The window's width in points, its layout, whether it lies on its side, and the page's margin. */
export interface WindowLayout {
  readonly width: number;
  readonly widthClass: WidthClass;
  /** Whether an iPad layout runs, `tablet` or `wide`, rather than the phone's. */
  readonly tablet: boolean;
  readonly landscape: boolean;
  readonly edge: number;
}

/** The current window's layout; it changes as the iPad rotates or the app resizes in Split View. */
export const useWindowLayout = (): WindowLayout => {
  const { width, height } = useWindowDimensions();
  const tablet = useThemeLength("--breakpoint-tablet");
  const wide = useThemeLength("--breakpoint-wide");
  const phoneEdge = useThemeLength("--spacing-mobile-edge");
  const tabletEdge = useThemeLength("--spacing-tablet-edge");
  const widthClass = widthClassOf(width, { tablet, wide });
  const phone = widthClass === "phone";

  return {
    width,
    widthClass,
    tablet: !phone,
    landscape: width > height,
    edge: phone ? phoneEdge : tabletEdge,
  };
};
