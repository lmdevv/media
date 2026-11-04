import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { KeyRound, Lock, Server } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { listedKeys } from "@/lib/account";
import { describeFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useServer } from "@/session/connection";

export default function Account() {
  const viewer = useCommandQuery("account.viewer", {});
  const accountScope = viewer.status === "success" && viewer.data.scopes.includes("account");
  const keys = useCommandQuery("apiKeys.list", accountScope ? {} : "skip");
  const server = useServer();

  if (viewer.status === "error") {
    return (
      <Screen readable header={<NavHeader title="Account" fallback="/you" />}>
        <CalmState
          title="Couldn’t Load Your Account"
          description={describeFailure(viewer.error)}
          actions={<Button label="Try Again" onPress={viewer.retry} />}
        />
      </Screen>
    );
  }

  return (
    <Screen readable scroll header={<NavHeader title="Account" fallback="/you" />}>
      {viewer.status === "loading" ? (
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      ) : (
        <>
          <TextField label="Name" value={viewer.data.user.name} editable={false} />
          <TextField label="Email" value={viewer.data.user.email ?? ""} editable={false} />
        </>
      )}
      {accountScope ? (
        <>
          <ListRow
            icon={Lock}
            title="Change Password"
            onPress={() => router.push("/change-password")}
          />
          <ListRow
            icon={KeyRound}
            title="API Keys"
            {...(keys.status === "success" ? { detail: String(listedKeys(keys.data).length) } : {})}
            onPress={() => router.push("/api-keys")}
          />
        </>
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
