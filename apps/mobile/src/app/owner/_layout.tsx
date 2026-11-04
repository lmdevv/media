import { useCommandQuery } from "@media/sdk/react";
import { Stack } from "expo-router";
import { Lock } from "lucide-react-native";

import { LoadFailure } from "@/components/owner/parts";
import { OwnerViewerContext, mayOpenOwnerSettings } from "@/components/owner/viewer";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { useSheetOptions } from "@/lib/sheet";

export default function OwnerLayout() {
  const viewer = useCommandQuery("account.viewer", {});

  const sheet = useSheetOptions();

  if (viewer.status === "loading")
    return (
      <Screen readable header={<NavHeader />}>
        {null}
      </Screen>
    );

  if (viewer.status === "error") {
    return (
      <Screen readable header={<NavHeader />}>
        <LoadFailure error={viewer.error} retry={viewer.retry} />
      </Screen>
    );
  }

  if (!mayOpenOwnerSettings(viewer.data)) {
    return (
      <Screen readable header={<NavHeader />}>
        <CalmState placement="top" icon={Lock} title="Only Admins Can Open This" />
      </Screen>
    );
  }

  return (
    <OwnerViewerContext.Provider value={viewer.data}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="libraries/[libraryId]/remove" options={sheet} />
        <Stack.Screen name="backups/[backupId]" options={sheet} />
        <Stack.Screen name="users/[userId]/disable" options={sheet} />
      </Stack>
    </OwnerViewerContext.Provider>
  );
}
