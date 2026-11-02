import { Stack } from "expo-router";
import type { NativeStackNavigationOptions } from "expo-router";

import { AppFailure } from "@/components/app-failure";
import { NOW_PLAYING_PRESENTATION } from "@/components/playback/now-playing-presentation";
import { SaveFailureProvider } from "@/components/states/save-failure";

import { PlayerProvider } from "@/player";
import { useConnection } from "@/session/connection";

import type { NowPlayingPresentation } from "@/lib/now-playing-layout";
import { useSheetOptions } from "@/lib/sheet";
import { SHEET_ROUTES } from "@/lib/shell-layout";
import { useThemeColor } from "@/lib/theme-color";

/** A link that opens a page over the tabs at launch, such as Settings, keeps the tabs under it. */
export const unstable_settings = { anchor: "(tabs)" };

const PLAYER: Readonly<Record<NowPlayingPresentation, NativeStackNavigationOptions>> = {
  sheet: { presentation: "modal" },
  window: { presentation: "transparentModal", contentStyle: { backgroundColor: "transparent" } },
};

const PLAYER_OPTIONS = PLAYER[NOW_PLAYING_PRESENTATION];

export default function AppLayout() {
  const sheet = useSheetOptions();
  const canvas = useThemeColor("--color-canvas");
  const { origin } = useConnection();

  return (
    <PlayerProvider origin={origin}>
      <SaveFailureProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="player" options={PLAYER_OPTIONS} />
          {SHEET_ROUTES.map((name) => (
            <Stack.Screen key={name} name={name} options={sheet} />
          ))}
        </Stack>
      </SaveFailureProvider>
    </PlayerProvider>
  );
}

export { AppFailure as ErrorBoundary };
