import { Stack } from "expo-router";
import { Lock } from "lucide-react-native";

import { mayOpenOwnerSettings } from "@/components/owner/viewer";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { useSheetOptions } from "@/lib/sheet";
import { useMe } from "@/session/me";

/** The owner screens, on the core's commands, for an owner or an admin only. */
export default function OwnerLayout() {
  const me = useMe();
  const sheet = useSheetOptions();

  if (!mayOpenOwnerSettings(me)) {
    return (
      <Screen readable header={<NavHeader />}>
        <CalmState placement="top" icon={Lock} title="Only Admins Can Open This" />
      </Screen>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="libraries/[libraryId]/remove" options={sheet} />
      <Stack.Screen name="backups/[backupId]" options={sheet} />
      <Stack.Screen name="devices/remove" options={sheet} />
    </Stack>
  );
}
