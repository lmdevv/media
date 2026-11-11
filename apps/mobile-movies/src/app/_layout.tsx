import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { StorageFullPrompt } from "@/components/downloads/storage-full-prompt";
import { ServerUnavailable } from "@/components/server-unavailable";
import { TitleStatesProvider } from "@/components/browse/title-states";
import { Button } from "@/components/ui/button";
import { applyAppearance } from "@/lib/appearance";
import { describeFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";
import { ConnectionProvider, useConnection, useServer } from "@/session/connection";
import { DownloadsProvider, useOfflinePerson } from "@/session/downloads";
import { ReportRenderErrors } from "@/session/error-reporting";
import { OfflineContext } from "@/session/offline";
import { FirstRunProvider, useHomeAfterSetup } from "@/session/first-run";
import { InviteLinks } from "@/session/invite-links";
import {
  PendingInviteProvider,
  useDropInviteWhenSignedIn,
  usePendingInvite,
} from "@/session/pending-invite";
import { PersonContext } from "@/session/me";
import { SdkProvider } from "@/session/sdk-provider";
import { SessionPhaseContext, useLiveSessionPhase, useSettledPhase } from "@/session/session-phase";
import { SignInGate } from "@/session/sign-in";
import { useSignOut } from "@/session/viewer";
import type { SessionPhase } from "@/session/session-phase";

applyAppearance();

void SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from "expo-router";

function NavigationTheme({ children }: { readonly children: ReactNode }) {
  const { theme } = useUniwind();
  const background = useThemeColor("--color-bg");
  const card = useThemeColor("--color-surface");
  const text = useThemeColor("--color-text");
  const border = useThemeColor("--color-hairline");
  const primary = useThemeColor("--color-accent");
  const base = theme === "light" ? DefaultTheme : DarkTheme;

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

const browseOrientation = Platform.OS === "ios" && Platform.isPad ? "default" : "portrait_up";

function RootStack({ phase }: { readonly phase: SessionPhase["kind"] | "offline" }) {
  const invite = usePendingInvite();
  const { theme } = useUniwind();

  useHomeAfterSetup(phase);

  const sheet = useSheetOptions();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        orientation: browseOrientation,
        statusBarStyle: theme === "light" ? "dark" : "light",
      }}
    >
      <Stack.Protected guard={phase === "disconnected"}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="connection-details" />
        <Stack.Screen name="open-invite" />
        <Stack.Screen name="unreachable" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut" && invite.code !== null}>
        <Stack.Screen name="join" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut" && invite.code === null}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-in-code" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "createOwner"}>
        <Stack.Screen name="create-owner" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "ready"}>
        <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
        <Stack.Screen name="title/[titleId]" />
        <Stack.Screen name="title/[titleId]/about" />
        <Stack.Screen name="title/[titleId]/seasons" options={sheet} />
        <Stack.Screen name="title/[titleId]/versions" options={sheet} />
        <Stack.Screen name="title/[titleId]/actions" options={sheet} />
        <Stack.Screen name="title/[titleId]/episode/[episodeId]" options={sheet} />
        <Stack.Screen name="you" />
        <Stack.Screen name="my-list" />
        <Stack.Screen name="account" />
        <Stack.Screen name="change-password" />
        <Stack.Screen name="connected-server" options={sheet} />
        <Stack.Screen name="sign-out" options={sheet} />
        <Stack.Screen name="history" />
        <Stack.Screen name="history-entry" options={sheet} />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/appearance" options={sheet} />
        <Stack.Screen name="settings/audio-subtitles" />
        <Stack.Screen name="settings/choose/[preference]" />
        <Stack.Screen name="settings/about" />
        <Stack.Screen name="settings/licenses" />
        <Stack.Screen name="settings/privacy" options={sheet} />
        <Stack.Screen name="devices/index" />
        <Stack.Screen name="devices/sign-out" options={sheet} />
        <Stack.Screen name="approve-device/index" />
        <Stack.Screen name="approve-device/scan" />
        <Stack.Screen name="approve-device/[userCode]" />
        <Stack.Screen name="collections" />
        <Stack.Screen name="collection/[collectionId]" />
        <Stack.Screen name="genre/[genre]" />
        <Stack.Screen name="person/[personId]" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "offline"}>
        <Stack.Screen name="offline" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "ready" || phase === "offline"}>
        <Stack.Screen name="download/[downloadId]" />
        <Stack.Screen name="download/[downloadId]/actions" options={sheet} />
        <Stack.Screen name="download/[downloadId]/remove" options={sheet} />
        <Stack.Screen name="download/[downloadId]/storage-full" options={sheet} />
        <Stack.Screen name="download-settings/index" />
        <Stack.Screen name="download-settings/quality" options={sheet} />
        <Stack.Screen name="download-settings/remove-all" options={sheet} />
        <Stack.Screen name="download-settings/menu" options={sheet} />
        <Stack.Screen
          name="watch/[titleId]"
          options={{
            presentation: "fullScreenModal",
            animation: "fade",
            orientation: "landscape",
            statusBarHidden: true,
            autoHideHomeIndicator: true,
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={phase === "setup" || phase === "ready"}>
        <Stack.Screen name="owner" options={phase === "setup" ? { animation: "fade" } : {}} />
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

const SLOW_LOAD_MS = 8000;

const useSlowLoad = (loading: boolean): boolean => {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);

    if (!loading) return undefined;
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);

    return () => clearTimeout(timer);
  }, [loading]);

  return slow;
};

function ConnectionTrouble({
  description,
  retry,
  onDownloads,
}: {
  readonly description?: string;
  readonly retry?: () => void;
  readonly onDownloads?: (() => void) | undefined;
}) {
  const { disconnect } = useConnection();
  const server = useServer();
  const signOut = useSignOut();

  return (
    <>
      <HideSplash />
      <ServerUnavailable
        description={description ?? `${displayHost(server.mediaUrl)} is unavailable.`}
        onRetry={retry}
        onChangeServer={disconnect}
        extra={
          <>
            {onDownloads === undefined ? null : (
              <Button label="Go to Downloads" variant="secondary" onPress={onDownloads} />
            )}
            <Button
              label="Sign Out"
              variant="plain"
              onPress={() => {
                void signOut().catch((cause: unknown) => {
                  Alert.alert("Couldn’t Sign Out", describeFailure(cause));
                });
              }}
            />
          </>
        }
      />
    </>
  );
}

function ConnectedApp() {
  const phase = useLiveSessionPhase();
  const settled = useSettledPhase(phase);
  const offlinePerson = useOfflinePerson();
  const [offline, setOffline] = useState(false);

  useDropInviteWhenSignedIn(settled !== null && settled.kind !== "signedOut");
  const slow = useSlowLoad(phase.kind === "loading");
  const signedIn = settled?.kind === "ready" || settled?.kind === "setup" ? settled.me : null;

  const person = useMemo(
    () => (signedIn === null ? null : { userId: signedIn.userId, username: signedIn.username }),
    [signedIn],
  );

  if (offline && offlinePerson !== null) {
    return (
      <OfflineContext.Provider
        value={{
          leave: () => {
            setOffline(false);

            if (phase.kind === "unavailable") phase.retry();
          },
        }}
      >
        <PersonContext.Provider value={offlinePerson}>
          <HideSplash />
          <TitleStatesProvider>
            <RootStack phase="offline" />
          </TitleStatesProvider>
        </PersonContext.Provider>
      </OfflineContext.Provider>
    );
  }

  const toDownloads = offlinePerson === null ? undefined : () => setOffline(true);
  let trouble: ReactNode = null;

  if (phase.kind === "unavailable") {
    trouble = (
      <ConnectionTrouble
        description={describeFailure(phase.cause)}
        retry={phase.retry}
        onDownloads={toDownloads}
      />
    );
  } else if (phase.kind === "loading" && slow) {
    trouble = <ConnectionTrouble onDownloads={toDownloads} />;
  }

  if (settled === null) return trouble;

  return (
    <SessionPhaseContext.Provider value={settled}>
      <PersonContext.Provider value={person}>
        <HideSplash />
        <TitleStatesProvider>
          <RootStack phase={settled.kind} />
          {settled.kind === "ready" ? <StorageFullPrompt /> : null}
        </TitleStatesProvider>
        {trouble === null ? null : (
          <View className="absolute inset-0" accessibilityViewIsModal>
            {trouble}
          </View>
        )}
      </PersonContext.Provider>
    </SessionPhaseContext.Provider>
  );
}

function App() {
  const { connection, joining } = useConnection();

  if (joining) return null;

  if (connection === null) {
    return (
      <>
        <HideSplash />
        <RootStack phase="disconnected" />
      </>
    );
  }

  return (
    <SdkProvider key={connection.convexUrl} connection={connection}>
      <ReportRenderErrors>
        <SignInGate>
          <FirstRunProvider>
            <DownloadsProvider>
              <ConnectedApp />
            </DownloadsProvider>
          </FirstRunProvider>
        </SignInGate>
      </ReportRenderErrors>
    </SdkProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationTheme>
        <ConnectionProvider>
          <PendingInviteProvider>
            <InviteLinks />
            <App />
          </PendingInviteProvider>
        </ConnectionProvider>
      </NavigationTheme>
    </GestureHandlerRootView>
  );
}
