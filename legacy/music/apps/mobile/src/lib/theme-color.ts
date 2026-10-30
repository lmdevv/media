/** Theme colors as strings, for native props that take a color rather than a class. */
import { useCSSVariable } from "uniwind";

/** A color role from the theme, such as `--color-accent`, following the current theme. */
export const useThemeColor = (variable: `--color-${string}`): string => {
  const value = useCSSVariable(variable);

  return value === undefined ? "transparent" : String(value);
};

/**
 * A length from the theme in points, such as `--spacing-ios-326`, for values animated on the UI
 * thread rather than set by class. Zero when the variable is missing.
 */
export const useThemeLength = (
  variable: `--${"spacing" | "radius" | "breakpoint" | "container"}-${string}`,
): number => {
  const value = Number.parseFloat(String(useCSSVariable(variable)));

  return Number.isFinite(value) ? value : 0;
};
