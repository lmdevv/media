import { router } from "expo-router";
import { Clapperboard, Info, Play, Sun, Captions, Volume2, Wifi } from "lucide-react-native";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Toggle } from "@/components/ui/toggle";
import {
  MOBILE_DATA_OPTIONS,
  QUALITY_OPTIONS,
  audioLabel,
  optionLabel,
  subtitlesLabel,
} from "@/lib/preferences";
import { APPEARANCE_OPTIONS } from "@/components/settings/appearance-options";
import { usePreferences, useUpdatePreferences } from "@/session/preferences";

export default function AppSettings() {
  const preferences = usePreferences();
  const updatePreferences = useUpdatePreferences();

  return (
    <Screen readable scroll header={<NavHeader title="App Settings" fallback="/you" />}>
      <ListRow
        icon={Sun}
        title="Appearance"
        detail={optionLabel(APPEARANCE_OPTIONS, preferences.appearance)}
        onPress={() => router.push("/settings/appearance")}
      />
      <ListRow
        icon={Clapperboard}
        title="Streaming Quality"
        detail={optionLabel(QUALITY_OPTIONS, preferences.quality)}
        onPress={() => router.push("/settings/choose/quality")}
      />
      <ListRow
        icon={Wifi}
        title="Mobile Data"
        detail={optionLabel(MOBILE_DATA_OPTIONS, preferences.mobileData)}
        onPress={() => router.push("/settings/choose/mobile-data")}
      />
      <ListRow
        icon={Volume2}
        title="Preferred Audio"
        detail={audioLabel(preferences)}
        onPress={() => router.push("/settings/audio-subtitles")}
      />
      <ListRow
        icon={Captions}
        title="Subtitles"
        detail={subtitlesLabel(preferences)}
        onPress={() => router.push("/settings/audio-subtitles")}
      />
      <ListRow
        icon={Play}
        iconFilled
        title="Autoplay Next Episode"
        trailing={
          <Toggle
            label="Autoplay Next Episode"
            value={preferences.autoplayNext}
            onValueChange={(autoplayNext) => updatePreferences({ autoplayNext })}
          />
        }
      />
      <View className="h-4" />
      <ListRow icon={Info} title="About [movies]" onPress={() => router.push("/settings/about")} />
    </Screen>
  );
}
