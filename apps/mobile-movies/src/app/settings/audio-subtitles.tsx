import { router } from "expo-router";

import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { audioLabel, subtitlesLabel } from "@/lib/preferences";
import { usePreferences } from "@/session/preferences";

export default function AudioAndSubtitles() {
  const preferences = usePreferences();

  return (
    <Screen readable scroll header={<NavHeader title="Audio & Subtitles" fallback="/settings" />}>
      <ListRow
        title="Preferred Audio"
        detail={audioLabel(preferences)}
        onPress={() => router.push("/settings/choose/audio")}
      />
      <ListRow
        title="Subtitles"
        detail={subtitlesLabel(preferences)}
        onPress={() => router.push("/settings/choose/subtitles")}
      />
      <ListRow
        title="Audio Description"
        detail={preferences.audioDescription ? "On" : "Off"}
        onPress={() => router.push("/settings/choose/audio-description")}
      />
    </Screen>
  );
}
