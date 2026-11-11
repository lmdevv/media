import { router } from "expo-router";
import { Clapperboard, Server, Trash2, Wifi } from "lucide-react-native";

import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Toggle } from "@/components/ui/toggle";
import { downloadsOf, summaryOf } from "@/lib/downloads/model";
import { qualityLabel } from "@/lib/downloads/settings";
import { DOWNLOADS_HREF } from "@/lib/routes";
import {
  updateDownloadSettings,
  useDownloadQuality,
  useDownloadSettings,
} from "@/session/download-settings";
import { useDownloads } from "@/session/downloads";

export default function DownloadSettings() {
  const settings = useDownloadSettings();
  const { quality } = useDownloadQuality();
  const { snapshot } = useDownloads();
  const downloads = snapshot === null ? [] : downloadsOf(snapshot.store);

  return (
    <Screen
      readable
      header={<NavHeader title="Download Settings" fallback={DOWNLOADS_HREF} />}
      contentClassName="gap-4 px-5 py-4"
    >
      <ListRow
        icon={Wifi}
        title="Wi-Fi Only"
        trailing={
          <Toggle
            label="Wi-Fi Only"
            value={settings.wifiOnly}
            onValueChange={(wifiOnly) => updateDownloadSettings({ wifiOnly })}
          />
        }
      />
      <ListRow
        icon={Clapperboard}
        title="Video Quality"
        detail={quality === null ? undefined : qualityLabel(quality)}
        disabled={quality === null}
        onPress={() => router.push("/download-settings/quality")}
      />
      <ListRow
        icon={Server}
        title="Storage Used"
        detail={summaryOf(downloads).size}
        onPress={() => router.navigate(DOWNLOADS_HREF)}
      />
      <ListRow
        icon={Trash2}
        title="Remove All Downloads"
        disabled={downloads.length === 0}
        onPress={() => router.push("/download-settings/remove-all")}
      />
    </Screen>
  );
}
