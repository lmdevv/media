import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { KeyRound } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useMadeKeys } from "@/session/made-keys";

export default function RevokeKey() {
  const params = useLocalSearchParams<{ keyId: string; name?: string }>();
  const platform = usePlatform();
  const made = useMadeKeys();
  const key = made.keys.find((each) => each.keyId === params.keyId) ?? null;

  return (
    <ConfirmSheet
      title="Revoke this key?"
      description={`${key?.name ?? params.name ?? "This key"} will lose access.`}
      action="Revoke Key"
      icon={KeyRound}
      onConfirm={async () => {
        if (key === null) throw new Error("This key can’t be found. Go back and try again.");
        await platform.core.auth.apiKeys.revoke({ keyId: key.keyId });
        made.revoked(key.keyId);
      }}
    />
  );
}
