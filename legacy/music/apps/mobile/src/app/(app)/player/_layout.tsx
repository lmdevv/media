/**
 * Now Playing's own stack, presented as a modal sheet over the tabs that the person drags down to
 * dismiss (B01, B11). The queue and the lyrics open in place inside it (B03, B12); the device
 * picker and confirmations present over it as form sheets. Song actions and audio details are the
 * app's sheets, over this one.
 */
import { Stack } from "expo-router";

import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";

export default function PlayerLayout() {
  const sheet = useSheetOptions();
  const canvas = useThemeColor("--color-canvas");

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="devices" options={sheet} />
      <Stack.Screen name="clear-queue" options={sheet} />
      <Stack.Screen name="unavailable" options={sheet} />
    </Stack>
  );
}
