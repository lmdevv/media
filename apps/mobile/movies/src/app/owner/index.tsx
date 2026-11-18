import { useHousehold } from "@media/mobile-core/use-accounts";
import { Redirect, router } from "expo-router";
import { Download, Folder, Server, Settings2, TvMinimal, Users } from "lucide-react-native";

import { OwnerScreen } from "@/components/owner/parts";
import { useManagedLibraries } from "@/components/owner/use-libraries";
import { ListRow } from "@/components/ui/list-row";
import { formatCount } from "@/lib/owner-format";
import { useSessionPhase } from "@/session/session-phase";

export default function OwnerSettings() {
  const phase = useSessionPhase();

  if (phase.kind === "setup") return <Redirect href="/owner/first-library" />;

  return <OwnerSettingsList />;
}

function OwnerSettingsList() {
  const libraries = useManagedLibraries();
  const users = useHousehold();

  return (
    <OwnerScreen title="Owner Settings" fallback="/">
      <ListRow
        icon={Folder}
        title="Libraries"
        detail={
          libraries.status === "ready" && libraries.next.kind === "done"
            ? formatCount(libraries.rows.length)
            : undefined
        }
        onPress={() => router.push("/owner/libraries")}
      />
      <ListRow
        icon={Users}
        title="Users & Invites"
        detail={
          users.status === "ready" && users.next.kind === "done"
            ? formatCount(users.rows.length)
            : undefined
        }
        onPress={() => router.push("/owner/users")}
      />
      <ListRow
        icon={Download}
        title="Import from Jellyfin or Plex"
        onPress={() => router.push("/owner/import")}
      />
      <ListRow icon={TvMinimal} title="Devices" onPress={() => router.push("/owner/devices")} />
      <ListRow icon={Server} title="Backups" onPress={() => router.push("/owner/backups")} />
      <ListRow icon={Settings2} title="Server" onPress={() => router.push("/owner/server")} />
    </OwnerScreen>
  );
}
