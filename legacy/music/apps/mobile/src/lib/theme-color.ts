/** Theme colors as strings, for native props that take a color rather than a class. */
import { useCSSVariable } from "uniwind";

/** A color role from the theme, such as `--color-accent`, following the current theme. */
export const useThemeColor = (variable: `--color-${string}`): string => {
  const value = useCSSVariable(variable);

  return value === undefined ? "transparent" : String(value);
};
