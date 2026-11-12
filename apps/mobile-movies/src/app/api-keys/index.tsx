import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
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
import { keyDetail } from "@/lib/api-keys";

const create = () => router.push("/api-keys/new");

export default function ApiKeys() {
  const platform = usePlatform();

  const keys = useAllPages(platform.core.auth.apiKeys.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const [now] = useState(Date.now);

  const header = (
    <NavHeader
      title="API Keys"
      fallback="/account"
      trailing={<IconButton icon={Plus} label="Create API Key" onPress={create} />}
    />
  );

  if (keys.status === "failed") {
    return (
      <Screen readable header={header}>
        <CalmState
          title="Couldn’t Load API Keys"
          description={keys.message}
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
        <>
          {keys.rows.map((key) => (
            <ListRow
              key={key.keyId}
              icon={KeyRound}
              title={key.name}
              detail={keyDetail(key, now)}
              onPress={() =>
                router.push({
                  pathname: "/api-keys/revoke",
                  params: { keyId: key.keyId, name: key.name },
                })
              }
            />
          ))}
          {keys.next.kind === "loading" || keys.next.kind === "more" ? (
            <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
          ) : null}
          {keys.next.kind === "failed" ? (
            <Button label="Try Again" variant="plain" onPress={keys.next.retry} />
          ) : null}
        </>
      )}
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
