import { APPEARANCE_OPTIONS } from "@/components/settings/appearance-options";
import { OptionList } from "@/components/settings/option-list";
import { Sheet } from "@/components/title/sheet";
import { usePreferences, useUpdatePreferences } from "@/session/preferences";

export default function AppearanceSheet() {
  const { appearance } = usePreferences();
  const updatePreferences = useUpdatePreferences();

  return (
    <Sheet title="Appearance">
      <OptionList
        options={APPEARANCE_OPTIONS}
        value={appearance}
        onChoose={(next) => updatePreferences({ appearance: next })}
      />
    </Sheet>
  );
}
