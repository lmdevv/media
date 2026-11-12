import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { asSessionId } from "@/lib/account";

/**
 * Signs one of the person's devices out. An app on a phone signed out this way asks for the
 * password again, even while the phone's grant stands (D59).
 */
export default function SignOutDevice() {
  const params = useLocalSearchParams<{ sessionId: string; name?: string }>();
  const platform = usePlatform();
  const name = params.name ?? "this device";

  return (
    <ConfirmSheet
      title={`Sign out ${name}?`}
      description="This device will need to sign in again."
      action="Sign Out Device"
      onConfirm={async () => {
        await platform.core.auth.sessions.end({ sessionId: asSessionId(params.sessionId) });
      }}
    />
  );
}
