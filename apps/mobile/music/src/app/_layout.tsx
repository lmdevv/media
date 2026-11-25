import "../global.css";

import type { Landing } from "@media/mobile-core/app-events";
import {
  AppEventsSender,
  ReportRenderErrors,
  useErrorRoute,
  useFirstScreen,
} from "@media/mobile-core/app-events-react";
import type { RenderErrorFallback } from "@media/mobile-core/app-events-react";
import {
  DarkTheme,
  DefaultTheme,
  ErrorBoundary,
  Stack,
  ThemeProvider,
  useSegments,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { EntryLinksProvider, OpenEntryLink } from "@/components/entry/entry-links";
import { DownloadsProvider } from "@/downloads";
import { appEvents } from "@/lib/app-events";
import { applyAppearance } from "@/lib/appearance";
import type { SettledPhase } from "@/lib/session-phase";
import { useThemeColor } from "@/lib/theme-color";
import { ConnectionProvider, useConnectionControls } from "@/session/connection";
import { SdkProvider } from "@/session/sdk-provider";
import { HeldHome } from "@/session/held-home";
import { ServerReachProvider } from "@/session/server-reach";
import {
  SessionPhaseContext,
  SetupProgressProvider,
  useSettledPhase,
} from "@/session/session-phase";
import { SignInGate } from "@/session/sign-in";

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

/** Hides the splash screen; the launch's first frame shows the screen that rendered this. */
function HideSplash({ landing }: { readonly landing: Landing }) {
  useFirstScreen(appEvents, landing);

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return null;
}

/** expo-router's error screen, over the splash screen when a launch fails before hiding it. */
const RenderFailed: RenderErrorFallback = (props) => {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return <ErrorBoundary {...props} />;
};

/** Names the route pattern on screen, such as `/album/[id]`, in error reports. */
function ErrorRoute() {
  useErrorRoute(appEvents, `/${useSegments().join("/")}`);

  return null;
}

function ConnectedApp() {
  const phase = useSettledPhase();

  // HeldHome stays first, so it keeps its place, and its queries, as the phase settles.
  return (
    <>
      <HeldHome phase={phase?.kind ?? null} />
      {phase === null ? (
        <View className="flex-1 bg-canvas" />
      ) : (
        <SessionPhaseContext value={phase}>
          <ServerReachProvider phase={phase.kind}>
            <HideSplash
              landing={phase.kind === "ready" || phase.kind === "offline" ? "home" : "elsewhere"}
            />
            <RootStack phase={phase.kind} />
            <OpenEntryLink phase={phase.kind} />
          </ServerReachProvider>
        </SessionPhaseContext>
      )}
    </>
  );
}

function App() {
  const { connection, joining, attempt } = useConnectionControls();

  if (joining) return <View className="flex-1 bg-canvas" />;

  if (connection === null) {
    return (
      <>
        <HideSplash landing="elsewhere" />
        <RootStack phase="disconnected" />
      </>
    );
  }

  return (
    <SdkProvider key={`${connection.mediaUrl}#${String(attempt)}`} connection={connection}>
      <AppEventsSender events={appEvents} mediaUrl={connection.mediaUrl} />
      <SignInGate>
        <SetupProgressProvider>
          <DownloadsProvider>
            <ConnectedApp />
          </DownloadsProvider>
        </SetupProgressProvider>
      </SignInGate>
    </SdkProvider>
  );
}

function ThemedStatusBar() {
  const { theme } = useUniwind();

  return <StatusBar barStyle={theme === "dark" ? "light-content" : "dark-content"} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ReportRenderErrors events={appEvents} fallback={RenderFailed}>
        <ErrorRoute />
        <ThemedStatusBar />
        <NavigationTheme>
          <ConnectionProvider>
            <EntryLinksProvider>
              <App />
            </EntryLinksProvider>
          </ConnectionProvider>
        </NavigationTheme>
      </ReportRenderErrors>
    </GestureHandlerRootView>
  );
}
