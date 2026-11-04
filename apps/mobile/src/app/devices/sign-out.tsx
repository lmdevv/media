import { AuthSessionId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";

const decodeSessionId = Schema.decodeUnknownOption(AuthSessionId);

export default function SignOutDevice() {
  const params = useLocalSearchParams<{ sessionId: string; name?: string }>();
  const sessionId = Option.getOrNull(decodeSessionId(params.sessionId));
  const revoke = useCommand("sessions.revoke");
  const name = params.name ?? "this device";

  return (
    <ConfirmSheet
      title={`Sign out ${name}?`}
      description="This device will need to sign in again."
      action="Sign Out Device"
      onConfirm={async () => {
        if (sessionId === null) {
          throw new Error("This device can’t be found. Go back and try again.");
        }

        await revoke({ sessionId });
      }}
    />
  );
}
