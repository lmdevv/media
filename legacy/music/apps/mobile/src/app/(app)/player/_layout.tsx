/**
 * Now Playing's own stack, presented as a modal sheet over the tabs that the person drags down to
 * dismiss (B01, B11) on an iPhone, or over the whole window on an iPad (P07), where the page is
 * see-through so the tabs show as it drags down. The queue and the lyrics open in place inside it
 * (B03, B12), or beside the player when wide (P08, P09); the device picker and confirmations
 * present over it as form sheets. Song actions and audio details are the app's sheets, over this
 * one.
 */
import { Stack } from "expo-router";

import { NOW_PLAYING_PRESENTATION } from "@/components/playback/now-playing-presentation";
import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";

/** Over the whole window, the page under Now Playing lets the tabs show through. */
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
