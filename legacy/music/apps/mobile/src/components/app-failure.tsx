/**
 * The signed-in app's error boundary, below the server session so a failed read never closes the
 * Convex client. Signing out clears the token while screens are still subscribed, so a read can
 * fail `unauthenticated` just before the session phase moves to Sign in; that case says so and
 * offers the way back in. Anything else offers Try again.
 */
import { commandFailure, errorMessage } from "@music/sdk/errors";
import type { ErrorBoundaryProps } from "expo-router";
import { CircleAlert, LogIn } from "lucide-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSignOut } from "@/session/sign-out";

import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";

/** What the signed-in app shows in place of a screen that threw. */
export function AppFailure({ error, retry }: ErrorBoundaryProps) {
  const signOut = useSignOut();
  const insets = useSafeAreaInsets();
  const signedOut = commandFailure(error)?.code === "unauthenticated";

  return (
    <View style={{ paddingTop: insets.top }} className="flex-1 bg-canvas px-page">
      {signedOut ? (
        <EmptyState
          icon={LogIn}
          title="You’re signed out."
          body={errorMessage(error)}
          primary={<Button label="Sign in again" onPress={() => void signOut()} />}
        />
      ) : (
        <EmptyState
          icon={CircleAlert}
          title="This screen didn’t load."
          body={errorMessage(error)}
          primary={<Button label="Try again" onPress={() => void retry()} />}
        />
      )}
    </View>
  );
}
