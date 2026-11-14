import { router } from "expo-router";
import { Check, Monitor } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { hostOf } from "@/lib/links";
import { useMusic, useRead } from "@/lib/platform";
import { useConnection } from "@/session/connection";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";

function SettingSwitch({
  title,
  body,
  value,
  disabled,
  onValueChange,
}: {
  readonly title: string;
  readonly body: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
      <View className="flex-1 gap-1">
        <Text variant="bodyMedium">{title}</Text>
        <Text variant="secondary" tone="muted">
          {body}
        </Text>
      </View>
      <Switch label={title} value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  );
}

/**
 * The server-wide settings an admin changes: looking up lyrics on LRCLIB (`music.lyrics.status`
 * and `music.lyrics.configure`). Old music's Jam guest accounts come back with group sessions.
 */
export function ServerSettingsForm() {
  const { mediaUrl } = useConnection();
  const music = useMusic();
  const settings = useRead(music.lyrics.status, {});
  const action = useAction();
  const [remote, setRemote] = useState<boolean | null>(null);
  const host = hostOf(mediaUrl);

  const save = () =>
    action.run(async () => {
      if (settings !== undefined && remote !== null && remote !== settings.remote) {
        await music.lyrics.configure({ remote });
      }

      router.back();
    });

  const busy = settings === undefined || action.pending;

  return (
    <Page
      title="Server settings"
      bottom="plain"
      trailing={<IconButton icon={Check} label="Save settings" onPress={save} />}
    >
      <Row
        leading={{ kind: "icon", icon: Monitor, tone: "muted" }}
        title={host}
        subtitle="Self-hosted"
      />
      <SectionHeader title="Lyrics" />
      <SettingSwitch
        title="Look up lyrics online"
        body="Sends the title, artist, album, and length of songs without lyrics to LRCLIB."
        value={remote ?? settings?.remote ?? false}
        disabled={busy}
        onValueChange={setRemote}
      />
      <View className="pt-6">
        <Button
          label="Save settings"
          pendingLabel="Saving…"
          pending={action.pending}
          disabled={settings === undefined}
          onPress={save}
        />
      </View>
      <Failure message={action.failure} />
    </Page>
  );
}
