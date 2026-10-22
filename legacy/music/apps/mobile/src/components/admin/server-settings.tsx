/**
 * F20 · Server settings: whether a Jam link may create a guest account. The switch is a draft
 * until Save settings (or the nav check) sends it, then the page closes.
 */
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
import { useConnection } from "@/session/connection";

import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";

/** The server-wide settings an admin changes. */
export function ServerSettingsForm() {
  const { origin } = useConnection();
  const settings = useRead("server.settings", {});
  const update = useRun("server.update");
  const action = useAction();
  // Untouched, the switch follows the saved value, including a change made elsewhere meanwhile.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const saved = settings?.jamGuestAccounts;
  const on = chosen ?? saved ?? false;
  const host = hostOf(origin);

  const save = () =>
    action.run(async () => {
      if (chosen !== null && chosen !== saved) await update({ jamGuestAccounts: chosen });

      router.back();
    });

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
      <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
        <View className="flex-1 gap-1">
          <Text variant="bodyMedium">Allow guest accounts</Text>
          <Text variant="secondary" tone="muted">
            People with a Jam link can create an account for that Jam.
          </Text>
        </View>
        <Switch
          label="Allow guest accounts"
          value={on}
          onValueChange={setChosen}
          disabled={settings === undefined || action.pending}
        />
      </View>
      <Notice
        icon={Lock}
        title="Temporary, limited access"
        body="Jam guests can only listen in the Jam. Their accounts are removed when it ends."
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
