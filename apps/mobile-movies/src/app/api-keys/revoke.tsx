import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { KeyRound } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { asApiKeyId } from "@/lib/api-keys";

export default function RevokeKey() {
  const params = useLocalSearchParams<{ keyId: string; name?: string }>();
  const platform = usePlatform();

  return (
    <ConfirmSheet
      title="Revoke this key?"
      description={`${params.name ?? "This key"} will lose access.`}
      action="Revoke Key"
      icon={KeyRound}
      onConfirm={async () => {
        await platform.core.auth.apiKeys.revoke({ keyId: asApiKeyId(params.keyId) });
      }}
    />
  );
}
