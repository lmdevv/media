import { Stack } from "expo-router";

import { NOW_PLAYING_PRESENTATION } from "@/components/playback/now-playing-presentation";
import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";

const INDEX =
  NOW_PLAYING_PRESENTATION === "window"
    ? { contentStyle: { backgroundColor: "transparent" } }
    : undefined;

export default function PlayerLayout() {
  const sheet = useSheetOptions();
  const canvas = useThemeColor("--color-canvas");

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
      <Stack.Screen name="index" options={INDEX} />
      <Stack.Screen name="devices" options={sheet} />
      <Stack.Screen name="clear-queue" options={sheet} />
      <Stack.Screen name="unavailable" options={sheet} />
    </Stack>
  );
}
