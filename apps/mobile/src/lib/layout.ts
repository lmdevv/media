/**
 * How much width the window gives the app: `compact` for an iPhone and narrow iPad windows such as
 * Slide Over, `regular` for an iPad in portrait or two-thirds of Split View, `wide` for an iPad in
 * landscape.
 */
export type WidthClass = "compact" | "regular" | "wide";

/** Where `regular` and `wide` start, in points. */
export interface WidthBreakpoints {
  readonly regular: number;
  readonly wide: number;
}

/** The class of a window `width` points wide. */
export const widthClassOf = (width: number, breakpoints: WidthBreakpoints): WidthClass => {
  if (width >= breakpoints.wide) return "wide";

  return width >= breakpoints.regular ? "regular" : "compact";
};

const BILLBOARD_SHARE = { regular: 0.62, wide: 0.7 } as const;

const BILLBOARD_MIN = 480;

const BILLBOARD_MAX = 760;

/** How tall Home's billboard is in an iPad window of this class and `windowHeight` points. */
export const billboardHeight = (
  widthClass: Exclude<WidthClass, "compact">,
  windowHeight: number,
): number =>
  Math.min(
    BILLBOARD_MAX,
    Math.max(BILLBOARD_MIN, Math.round(windowHeight * BILLBOARD_SHARE[widthClass])),
  );

/** The page a horizontal pager of `pages` pages, each `pageWidth` wide, rests on at `offset`. */
export const pageAt = (offset: number, pageWidth: number, pages: number): number =>
  pageWidth <= 0 || pages <= 0
    ? 0
    : Math.min(pages - 1, Math.max(0, Math.round(offset / pageWidth)));
