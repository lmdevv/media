/**
 * The signed-in app: the tabs, then everything pushed or presented over them. Pages Paper draws
 * without the tab bar (settings, Jams, playlist editing) push here, above the tabs; Paper's bottom
 * sheets present here as native form sheets; Now Playing is a modal with its own stack. Downloads
 * sit above the player, which plays downloaded songs from their files.
 */
import { Stack } from "expo-router";

import { AppFailure } from "@/components/app-failure";
import { SaveFailureProvider } from "@/components/states/save-failure";

import { DownloadsProvider } from "@/downloads";
import { PlayerProvider } from "@/player";
import { useConnection } from "@/session/connection";

import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";

/** A link that opens a page over the tabs at launch, such as Settings, keeps the tabs under it. */
export const unstable_settings = { anchor: "(tabs)" };

/** Routes Paper draws as bottom sheets, presented as native form sheets. */
const SHEETS = [
  "song/[id]/actions",
  "song/[id]/add-to-playlist",
  "sort/[list]",
  "album/[id]/actions",
  "download/remove",
  "playlist/[id]/actions",
  "playlist/[id]/delete",
  "playlist/[id]/share/[userId]",
  "playlist/[id]/share/add",
  "playlist/[id]/leave",
  "jam/start",
  "jam/manage",
  "jam/end",
  "jam/remove/[userId]",
  "settings/downloads/remove-all",
  "settings/keys/[id]/revoke",
  "settings/admin/people/[id]/remove",
  "settings/admin/people/[id]/suspend",
  "settings/admin/people/[id]/transfer",
  "settings/admin/libraries/[id]/remove",
  "settings/admin/jobs/[id]/cancel",
  "save-failed",
] as const;

export default function AppLayout() {
  const sheet = useSheetOptions();
  const canvas = useThemeColor("--color-canvas");
  const { origin } = useConnection();

  return (
    <DownloadsProvider>
      <PlayerProvider origin={origin}>
        <SaveFailureProvider>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="player" options={{ presentation: "modal" }} />
            {SHEETS.map((name) => (
              <Stack.Screen key={name} name={name} options={sheet} />
            ))}
          </Stack>
        </SaveFailureProvider>
      </PlayerProvider>
    </DownloadsProvider>
  );
}

export { AppFailure as ErrorBoundary };
