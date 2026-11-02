import { Stack } from "expo-router";

import { useContentCanvas } from "@/lib/window-layout";

/** A link that opens a page (an album, say) at launch keeps the tab's root under it, for Back. */
export const unstable_settings = { anchor: "index" };

export default function TabStackLayout() {
  const canvas = useContentCanvas();

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }} />
  );
}
