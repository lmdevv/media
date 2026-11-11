import { usePlatform } from "@media/sdk/react";
import { KeyRound } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useMadeKeys } from "@/session/made-keys";

export default function EndAllKeys() {
  const platform = usePlatform();
  const { endedAll } = useMadeKeys();

  return (
    <ConfirmSheet
      title="End all API keys?"
      description="Every API key on your account stops working, including ones made elsewhere."
      action="End All Keys"
      icon={KeyRound}
      onConfirm={async () => {
        await platform.core.auth.apiKeys.endAll();
        endedAll();
      }}
    />
  );
}
