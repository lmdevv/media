import { useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";

import { OptionList } from "@/components/settings/option-list";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Toggle } from "@/components/ui/toggle";
import {
  AUDIO_OPTIONS,
  MOBILE_DATA_OPTIONS,
  QUALITY_OPTIONS,
  SUBTITLE_OPTIONS,
} from "@/lib/preferences";
import type { PreferenceOption } from "@/lib/preferences";
import { usePreferences, useUpdatePreferences } from "@/session/preferences";

const SWITCH_OPTIONS: ReadonlyArray<PreferenceOption<boolean>> = [
  { value: false, label: "Off" },
  { value: true, label: "On" },
];

function Picker({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Screen readable scroll header={<NavHeader title={title} fallback="/settings" />}>
      {children}
    </Screen>
  );
}

export default function PreferencePicker() {
  const { preference } = useLocalSearchParams<{ preference: string }>();
  const preferences = usePreferences();
  const updatePreferences = useUpdatePreferences();

  switch (preference) {
    case "quality":
      return (
        <Picker title="Streaming Quality">
          <OptionList
            options={QUALITY_OPTIONS}
            value={preferences.quality}
            onChoose={(quality) => updatePreferences({ quality })}
          />
        </Picker>
      );
    case "mobile-data":
      return (
        <Picker title="Mobile Data">
          <OptionList
            options={MOBILE_DATA_OPTIONS}
            value={preferences.mobileData}
            onChoose={(mobileData) => updatePreferences({ mobileData })}
          />
        </Picker>
      );
    case "audio":
      return (
        <Picker title="Preferred Audio">
          <OptionList
            options={AUDIO_OPTIONS}
            value={preferences.audioLanguage}
            onChoose={(audioLanguage) => updatePreferences({ audioLanguage })}
          />
        </Picker>
      );
    case "subtitles":
      return (
        <Picker title="Subtitles">
          {preferences.subtitleLanguage === null ? null : (
            <ListRow
              title="Subtitles for the Deaf (SDH)"
              trailing={
                <Toggle
                  label="Subtitles for the Deaf (SDH)"
                  value={preferences.subtitlesSdh}
                  onValueChange={(subtitlesSdh) => updatePreferences({ subtitlesSdh })}
                />
              }
            />
          )}
          <OptionList
            options={SUBTITLE_OPTIONS}
            value={preferences.subtitleLanguage}
            onChoose={(subtitleLanguage) => updatePreferences({ subtitleLanguage })}
          />
        </Picker>
      );
    case "audio-description":
      return (
        <Picker title="Audio Description">
          <OptionList
            options={SWITCH_OPTIONS}
            value={preferences.audioDescription}
            onChoose={(audioDescription) => updatePreferences({ audioDescription })}
          />
        </Picker>
      );
    default:
      return (
        <Screen readable header={<NavHeader fallback="/settings" />}>
          <CalmState placement="top" title="Not Found" />
        </Screen>
      );
  }
}
