import { describeFailure } from "@media/mobile-core/failure";
import { MUSIC, useMusicSession } from "@media/player/session-react";
import type { SessionSettings } from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { useState } from "react";
import { View } from "react-native";

import { Page } from "@/components/ui/page";
import { Row, RowCheck } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

const JOIN: ReadonlyArray<{ readonly value: SessionSettings["join"]; readonly label: string }> = [
  { value: "open", label: "Anyone with the link" },
  { value: "approval", label: "You approve" },
  { value: "locked", label: "Locked" },
];

function ToggleRow({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <View className="min-h-hit-target flex-row items-center justify-between gap-4 py-2">
      <Text className="flex-1">{label}</Text>
      <Switch label={label} value={value} onValueChange={onChange} />
    </View>
  );
}

/** The host's Jam settings: who can join, and what everyone else may do. */
export default function JamSettings() {
  const platform = usePlatform();
  const { view } = useMusicSession();
  const [failure, setFailure] = useState<string | null>(null);

  if (view?.state !== "joined" || view.role !== "host") {
    return (
      <Page title="Jam settings" bottom="plain">
        {null}
      </Page>
    );
  }

  const { settings } = view;

  const change = (changes: Partial<SessionSettings>) => {
    setFailure(null);
    platform.core.together
      .configure({ domain: MUSIC, ...settings, ...changes })
      .catch((cause: unknown) => {
        setFailure(describeFailure(cause));
      });
  };

  return (
    <Page title="Jam settings" bottom="plain">
      <SectionHeader title="Who can join" first />
      {JOIN.map((option) => (
        <Row
          key={option.value}
          title={option.label}
          {...(settings.join === option.value ? { trailing: <RowCheck /> } : {})}
          onPress={() => {
            change({ join: option.value });
          }}
        />
      ))}
      <SectionHeader title="Everyone else" />
      <ToggleRow
        label="People can add songs"
        value={settings.add}
        onChange={(add) => {
          change({ add });
        }}
      />
      <ToggleRow
        label="People can play, pause, skip, and seek"
        value={settings.control}
        onChange={(control) => {
          change({ control });
        }}
      />
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2">
          {failure}
        </Text>
      )}
    </Page>
  );
}
