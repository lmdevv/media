import { router } from "expo-router";
import { KeyRound, Lock, Server } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { displayHost } from "@/lib/local-network";
import { useServer } from "@/session/connection";
import { useMe } from "@/session/me";

export default function Account() {
  const me = useMe();
  const server = useServer();

  return (
    <Screen readable scroll header={<NavHeader title="Account" fallback="/you" />}>
      <TextField label="Username" value={me.username} editable={false} />
      {me.scopes.includes("account") ? (
        <ListRow
          icon={Lock}
          title="Change Password"
          onPress={() => router.push("/change-password")}
        />
      ) : null}
      {me.scopes.includes("account") ? (
        <ListRow icon={KeyRound} title="API Keys" onPress={() => router.push("/api-keys")} />
      ) : null}
      <ListRow
        icon={Server}
        title="Connected Server"
        detail={displayHost(server.mediaUrl)}
        onPress={() => router.push("/connected-server")}
      />
      <View className="h-8" />
      <Button label="Sign Out" variant="secondary" onPress={() => router.push("/sign-out")} />
    </Screen>
  );
}
