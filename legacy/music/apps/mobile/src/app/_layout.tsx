import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { EntryLinksProvider, OpenEntryLink } from "@/components/entry/entry-links";
import { applyAppearance } from "@/lib/appearance";
import type { SettledPhase } from "@/lib/session-phase";
import { useThemeColor } from "@/lib/theme-color";
import { ConnectionProvider, useConnectionControls } from "@/session/connection";
import { ServerSession } from "@/session/server-session";
import {
  SessionEndProvider,
  SetupProgressProvider,
  useSettledPhase,
} from "@/session/session-phase";
import { ServerReachProvider } from "@/session/server-reach";
import { DownloadsProvider } from "@/downloads";

applyAppearance();

void SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from "expo-router";

function NavigationTheme({ children }: { readonly children: ReactNode }) {
  const { theme } = useUniwind();
  const background = useThemeColor("--color-canvas");
  const card = useThemeColor("--color-bg");
  const text = useThemeColor("--color-text");
  const border = useThemeColor("--color-border");
  const primary = useThemeColor("--color-accent");
  const base = theme === "dark" ? DarkTheme : DefaultTheme;

  return (
    <ThemeProvider
      value={{
        ...base,
        colors: { ...base.colors, background, card, text, border, primary, notification: primary },
      }}
    >
      {children}
    </ThemeProvider>
  );
}

const FIRST_SCREEN = {
  disconnected: "/welcome",
  signedOut: "/sign-in",
  suspended: "/suspended",
  needsOwner: "/setup/owner",
  needsLibrary: "/setup/folder",
  scanning: "/setup/scan",
  unreachable: "/unreachable",
  offline: "/",
  ready: "/",
} as const satisfies Record<SettledPhase["kind"], string>;

function RootStack({ phase }: { readonly phase: SettledPhase["kind"] }) {
  const canvas = useThemeColor("--color-canvas");
  const first = FIRST_SCREEN[phase];

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
      <Stack.Protected guard={phase === "disconnected"} redirectTo={first}>
        <Stack.Screen name="(entry)/welcome" />
        <Stack.Screen name="(entry)/connect" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut"} redirectTo={first}>
        <Stack.Screen name="(entry)/sign-in" />
        <Stack.Screen name="(entry)/invite/[code]" />
        <Stack.Screen name="(entry)/reset/[token]" />
        <Stack.Screen name="(entry)/jam-guest/[code]" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "suspended"} redirectTo={first}>
        <Stack.Screen name="(entry)/suspended" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "needsOwner"} redirectTo={first}>
        <Stack.Screen name="(entry)/setup/owner" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut" || phase === "needsOwner"} redirectTo={first}>
        <Stack.Screen name="(entry)/change-server" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "needsLibrary"} redirectTo={first}>
        <Stack.Screen name="(entry)/setup/folder" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "scanning"} redirectTo={first}>
        <Stack.Screen name="(entry)/setup/scan" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "unreachable"} redirectTo={first}>
        <Stack.Screen name="unreachable" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "ready" || phase === "offline"} redirectTo={first}>
        <Stack.Screen name="(app)" options={{ animation: "fade" }} />
      </Stack.Protected>
    </Stack>
  );
}

function HideSplash() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return null;
}

function ConnectedApp() {
  const phase = useSettledPhase();

  if (phase === null) return <View className="flex-1 bg-canvas" />;

  return (
    <ServerReachProvider phase={phase.kind}>
      <HideSplash />
      <RootStack phase={phase.kind} />
      <OpenEntryLink phase={phase.kind} />
    </ServerReachProvider>
  );
}

function App() {
  const { connection, attempt } = useConnectionControls();

  if (connection === null) {
    return (
      <>
        <HideSplash />
        <RootStack phase="disconnected" />
      </>
    );
  }

  return (
    <ServerSession key={`${connection.convexUrl}#${String(attempt)}`} connection={connection}>
      <SetupProgressProvider>
        <SessionEndProvider>
          <DownloadsProvider>
            <ConnectedApp />
          </DownloadsProvider>
        </SessionEndProvider>
      </SetupProgressProvider>
    </ServerSession>
  );
}

function ThemedStatusBar() {
  const { theme } = useUniwind();

  return <StatusBar barStyle={theme === "dark" ? "light-content" : "dark-content"} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemedStatusBar />
      <NavigationTheme>
        <ConnectionProvider>
          <EntryLinksProvider>
            <App />
          </EntryLinksProvider>
        </ConnectionProvider>
      </NavigationTheme>
    </GestureHandlerRootView>
  );
}
