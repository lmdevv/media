/**
 * F20 · Server settings: whether a Jam link may create a guest account, and whether lyrics are
 * looked up on LRCLIB for songs without them. The switches are drafts until Save settings (or the
 * nav check) sends the ones the person changed, then the page closes.
 */
import type { ServerSettings } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Check, Lock, Monitor } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { hostOf } from "@/lib/links";
import { settingsUpdate } from "@/lib/server-settings";
import { useConnection } from "@/session/connection";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";

/** A setting's switch with its title and the line that explains it. */
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

/** The server-wide settings an admin changes. */
export function ServerSettingsForm() {
  const { origin } = useConnection();
  const settings = useRead("server.settings", {});
  const update = useRun("server.update");
  const action = useAction();
  // Untouched, a switch follows the saved value, including a change made elsewhere meanwhile.
  const [chosen, setChosen] = useState<Partial<ServerSettings>>({});
  const host = hostOf(origin);

  const save = () =>
    action.run(async () => {
      const changed = settings === undefined ? null : settingsUpdate(chosen, settings);

      if (changed !== null) await update(changed);

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
      <SectionHeader title="Jam guests" />
      <SettingSwitch
        title="Allow guest accounts"
        body="People with a Jam link can create an account for that Jam."
        value={chosen.jamGuestAccounts ?? settings?.jamGuestAccounts ?? false}
        disabled={busy}
        onValueChange={(jamGuestAccounts) => {
          setChosen((current) => ({ ...current, jamGuestAccounts }));
        }}
      />
      <Notice
        icon={Lock}
        title="Temporary, limited access"
        body="Jam guests can only listen in the Jam. Their accounts are removed when it ends."
      />
      <SectionHeader title="Lyrics" />
      <SettingSwitch
        title="Look up lyrics online"
        body="Sends the title, artist, album, and length of songs without lyrics to LRCLIB."
        value={chosen.remoteLyrics ?? settings?.remoteLyrics ?? false}
        disabled={busy}
        onValueChange={(remoteLyrics) => {
          setChosen((current) => ({ ...current, remoteLyrics }));
        }}
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
