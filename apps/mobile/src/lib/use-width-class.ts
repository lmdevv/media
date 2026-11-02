import { Platform, useWindowDimensions } from "react-native";
import { useCSSVariable } from "uniwind";

import { GRID_SPACING, gridColumns } from "./browse";
import type { GridSpacing } from "./browse";
import { widthClassOf } from "./layout";
import type { WidthClass } from "./layout";

type CssValue = string | number | undefined;

const breakpoint = (name: string, value: CssValue): number => {
  const points = Number.parseFloat(String(value));

  if (Number.isNaN(points)) throw new Error(`${name} is missing from global.css`);

  return points;
};

/**
 * The window's class, from the `--breakpoint-*` tokens behind the `regular:` and `wide:` class
 * variants, so code and classes switch at the same width. An iPhone is always compact: turned for
 * the player it is as wide as an iPad mini, with a phone's height.
 */
export const useWidthClass = (): WidthClass => {
  const { width } = useWindowDimensions();
  const [regular, wide] = useCSSVariable(["--breakpoint-regular", "--breakpoint-wide"]);

  const breakpoints = {
    regular: breakpoint("--breakpoint-regular", regular),
    wide: breakpoint("--breakpoint-wide", wide),
  };

  return Platform.OS === "ios" && Platform.isPad ? widthClassOf(width, breakpoints) : "compact";
};

/** A poster grid's columns, and the space around and between its posters. */
export interface GridLayout {
  readonly columns: number;
  readonly spacing: GridSpacing;
}

/** The poster grid for the window. */
export const useGridLayout = (): GridLayout => {
  const { width } = useWindowDimensions();
  const spacing = GRID_SPACING[useWidthClass()];

  return { columns: gridColumns(width, spacing), spacing };
};
