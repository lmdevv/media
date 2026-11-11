import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { KeyRound } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { MADE_KEYS, useMadeKeys } from "@/session/made-keys";

export default function RevokeKey() {
  const params = useLocalSearchParams<{ keyId: string; name?: string }>();
  const platform = usePlatform();
  const key = useMadeKeys().find((made) => made.keyId === params.keyId) ?? null;

  return (
    <ConfirmSheet
      title="Revoke this key?"
      description={`${key?.name ?? params.name ?? "This key"} will lose access.`}
      action="Revoke Key"
      icon={KeyRound}
      onConfirm={async () => {
        if (key === null) throw new Error("This key can’t be found. Go back and try again.");
        await platform.core.auth.apiKeys.revoke({ keyId: key.keyId });
        MADE_KEYS.revoked(key.keyId);
      }}
    />
  );
}
