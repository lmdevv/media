import Constants from "expo-constants";
import { router } from "expo-router";
import { Info, Server, ShieldCheck } from "lucide-react-native";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { displayHost } from "@/lib/local-network";
import { useServer } from "@/session/connection";

export default function About() {
  const server = useServer();
  const version = Constants.expoConfig?.version;

  return (
    <Screen readable scroll header={<NavHeader title="About [movies]" fallback="/settings" />}>
      <View className="h-12" />
      <Text variant="wordmark" tone="accent" accessibilityRole="header">
        [movies]
      </Text>
      {version === undefined ? null : <Text tone="muted">{`Version ${version}`}</Text>}
      <ListRow
        icon={Info}
        title="Open Source Licenses"
        onPress={() => router.push("/settings/licenses")}
      />
      <ListRow
        icon={Server}
        title="Connected Server"
        detail={displayHost(server.mediaUrl)}
        onPress={() => router.push("/connected-server")}
      />
      <ListRow
        icon={ShieldCheck}
        title="Privacy"
        onPress={() => router.push("/settings/privacy")}
      />
    </Screen>
  );
}
