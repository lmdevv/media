/** The window's layout from Paper's breakpoints, for what a class can't change, such as columns. */
import { createContext, use } from "react";
import { useWindowDimensions } from "react-native";
import { useUniwind } from "uniwind";

import { contentClassOf, widthClassOf } from "./layout";
import type { WidthClass } from "./layout";
import { useThemeColor, useThemeLength } from "./theme-color";

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

/**
 * The width in points of the area beside the iPad's sidebar, set by the shell. Null outside that
 * area, and on an iPhone, where the window is the content.
 */
export const ContentWidthContext = createContext<number | null>(null);

/**
 * The layout a page in the tabs gets from the room it has, rather than from the window: what a
 * pinned sidebar leaves. That room sets its column counts and whether a header stacks. Whether it
 * has an iPad layout at all follows the window, as the frame and `tablet:` variants do.
 */
export const useContentLayout = (): WindowLayout => {
  const window = useWindowLayout();
  const content = use(ContentWidthContext);
  const tablet = useThemeLength("--breakpoint-tablet");
  const wide = useThemeLength("--breakpoint-wide");

  if (content === null) return window;

  return {
    ...window,
    width: content,
    widthClass: contentClassOf(window.widthClass, content, { tablet, wide }),
  };
};

/** The class for what lies behind a page: `bg-content` in the area beside the sidebar. */
export const usePageBackground = (): "bg-content" | "bg-canvas" =>
  use(ContentWidthContext) === null ? "bg-canvas" : "bg-content";

/**
 * The color behind a page in the tabs, as the `bg-content` class draws it: the canvas, except in
 * dark mode from `tablet` up, where the page is a raised panel on the black canvas (B1 dark).
 */
export const useContentCanvas = (): string => {
  const canvas = useThemeColor("--color-canvas");
  const panel = useThemeColor("--color-bg");
  const { tablet } = useWindowLayout();
  const dark = useUniwind().theme === "dark";

  return tablet && dark ? panel : canvas;
};
