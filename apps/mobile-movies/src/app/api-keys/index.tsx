import { router } from "expo-router";
import { KeyRound, Plus } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useMadeKeys } from "@/session/made-keys";

const create = () => router.push("/api-keys/new");

export default function ApiKeys() {
  const keys = useMadeKeys();

  return (
    <Screen
      readable
      scroll
      header={
        <NavHeader
          title="API Keys"
          fallback="/account"
          trailing={<IconButton icon={Plus} label="Create API Key" onPress={create} />}
        />
      }
    >
      <Text tone="muted">
        Keys made on this iPhone since the app opened. The server can’t list every key yet.
      </Text>
      {keys.map((key) => (
        <ListRow
          key={key.keyId}
          icon={KeyRound}
          title={key.name}
          detail={key.detail}
          onPress={() =>
            router.push({
              pathname: "/api-keys/revoke",
              params: { keyId: key.keyId, name: key.name },
            })
          }
        />
      ))}
      <View className="h-6" />
      <Button label="Create API Key" icon={Plus} onPress={create} />
      <Button
        label="End All Keys"
        variant="secondary"
        onPress={() => router.push("/api-keys/end-all")}
      />
    </Screen>
  );
}
