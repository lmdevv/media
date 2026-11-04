import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { KeyRound, Plus } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { keyDetail, listedKeys } from "@/lib/account";
import { describeFailure } from "@/lib/failure";

const create = () => router.push("/api-keys/new");

export default function ApiKeys() {
  const keys = useCommandQuery("apiKeys.list", {});
  const [now] = useState(Date.now);

  const header = (
    <NavHeader
      title="API Keys"
      fallback="/account"
      trailing={<IconButton icon={Plus} label="Create API Key" onPress={create} />}
    />
  );

  if (keys.status === "error") {
    return (
      <Screen readable header={header}>
        <CalmState
          title="Couldn’t Load API Keys"
          description={describeFailure(keys.error)}
          actions={<Button label="Try Again" onPress={keys.retry} />}
        />
      </Screen>
    );
  }

  return (
    <Screen readable scroll header={header}>
      {keys.status === "loading" ? (
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      ) : (
        listedKeys(keys.data).map((key) => (
          <ListRow
            key={key.id}
            icon={KeyRound}
            title={key.name}
            detail={keyDetail(key, now)}
            onPress={() =>
              router.push({
                pathname: "/api-keys/revoke",
                params: { apiKeyId: key.id, name: key.name },
              })
            }
          />
        ))
      )}
      <View className="h-6" />
      <Button label="Create API Key" icon={Plus} onPress={create} />
    </Screen>
  );
}
