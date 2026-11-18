/**
 * The stack options of the Search and Downloads tabs: the native header with a 34pt large title
 * that collapses into the bar as the content scrolls, on the page's background (E01, C20). The bar
 * keeps the system's own background: on iOS 26 a `headerStyle` color paints over the large title.
 */
import type { NativeStackNavigationOptions } from "expo-router";
import { useMemo } from "react";
import { useCSSVariable } from "uniwind";

import { useThemeColor } from "@/lib/theme-color";

/** Screen options for a tab's stack, following the current theme. */
export const useTabStackOptions = (): NativeStackNavigationOptions => {
  const background = useThemeColor("--color-bg");
  const text = useThemeColor("--color-text");
  const bold = String(useCSSVariable("--font-sans-bold"));
  const semibold = String(useCSSVariable("--font-sans-semibold"));

  return useMemo(
    () => ({
      headerLargeTitleEnabled: true,
      headerShadowVisible: false,
      headerLargeTitleShadowVisible: false,
      headerTintColor: text,
      headerLargeTitleStyle: { fontFamily: bold, color: text },
      headerTitleStyle: { fontFamily: semibold, color: text },
      contentStyle: { backgroundColor: background },
    }),
    [background, text, bold, semibold],
  );
};
