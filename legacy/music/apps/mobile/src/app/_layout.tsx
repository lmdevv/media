/**
 * The root: providers, then one stack whose screens are grouped by session phase. Changing phase
 * (connecting, signing in, finishing setup, signing out) sends the stack to the first screen the
 * new phase allows, so no screen navigates on those events itself.
 */
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

applyAppearance();

void SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from "expo-router";

/** React Navigation's colors from the theme tokens, so native transitions and sheets match. */
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

/**
 * Each phase's first screen, where the stack goes when the screen on show leaves the phase.
 * Without it the router picks the shortest allowed route name, so Connect hid Welcome at launch.
 */
const FIRST_SCREEN = {
  disconnected: "/welcome",
  signedOut: "/sign-in",
  suspended: "/suspended",
  needsOwner: "/setup/owner",
  needsLibrary: "/setup/folder",
  scanning: "/setup/scan",
  unreachable: "/unreachable",
  ready: "/",
} as const satisfies Record<SettledPhase["kind"], string>;

/** Every screen outside the signed-in app, grouped by the phase that may show it. */
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
      {/* After each phase's own first screen: Back on Sign in and on Create account opens it. */}
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
      <Stack.Protected guard={phase === "ready"} redirectTo={first}>
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

/** The app on a connected server: the splash until the server first answers, then its phase. */
function ConnectedApp() {
  const phase = useSettledPhase();

  // Shown only right after connecting, when the splash is already gone: a blank page, not a flash.
  if (phase === null) return <View className="flex-1 bg-canvas" />;

  return (
    <>
      <HideSplash />
      <RootStack phase={phase.kind} />
      <OpenEntryLink phase={phase.kind} />
    </>
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
          <ConnectedApp />
        </SessionEndProvider>
      </SetupProgressProvider>
    </ServerSession>
  );
}

/**
 * The status bar in the app's theme, which can differ from the system's. The app-wide style is
 * what iOS uses here: the app doesn't opt into per-screen status bar styles.
 */
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
