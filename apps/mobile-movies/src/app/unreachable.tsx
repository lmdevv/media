import { router, useLocalSearchParams } from "expo-router";
import { Wifi } from "lucide-react-native";
import { Linking } from "react-native";

import { ServerUnavailable } from "@/components/server-unavailable";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { discoverServer, normalizeServerUrl } from "@media/mobile-core/server";
import { displayHost, isLocalNetworkUrl } from "@/lib/local-network";
import { useConnectAttempt } from "@/session/connect-attempt";
import { usePendingInvite } from "@/session/pending-invite";

const back = () => router.back();

export default function Unreachable() {
  const { address = "", invite } = useLocalSearchParams<{ address?: string; invite?: string }>();
  const { busy, run } = useConnectAttempt();
  const { setInvite } = usePendingInvite();

  const retry = () =>
    void run(() => discoverServer(address), {
      filled: address !== "",
      beforeConnect: (connection) => {
        if (invite !== undefined) setInvite({ server: connection.mediaUrl, code: invite });
      },
    });

  const url = normalizeServerUrl(address) ?? address;

  if (isLocalNetworkUrl(url)) {
    return (
      <Screen readable header={<NavHeader title="Local Network Access" onBack={back} />}>
        <CalmState
          placement="top"
          icon={Wifi}
          title="Local server unavailable"
          description="Allow local network access in Settings."
          actions={
            <>
              <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
              <Button label="Enter a Remote Address" variant="secondary" onPress={back} />
            </>
          }
        />
      </Screen>
    );
  }

  return (
    <ServerUnavailable
      description={`${displayHost(url)} is unavailable.`}
      onRetry={retry}
      retrying={busy}
      onChangeServer={back}
      onBack={back}
    />
  );
}
