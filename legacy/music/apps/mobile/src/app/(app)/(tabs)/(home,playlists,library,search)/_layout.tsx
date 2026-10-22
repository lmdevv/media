/**
 * Each tab's own stack, so Home, Playlists, Library, and Search keep independent navigation.
 * Pages draw their own bars (Paper's large title or back bar), so the native header stays off;
 * with a page's scroll view as its root, UIKit still finds it to minimize the tab bar.
 */
import { Stack } from "expo-router";

import { useThemeColor } from "@/lib/theme-color";

/** A link that opens a page (an album, say) at launch keeps the tab's root under it, for Back. */
export const unstable_settings = { anchor: "index" };

export default function TabStackLayout() {
  const canvas = useThemeColor("--color-canvas");

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }} />
  );
}
