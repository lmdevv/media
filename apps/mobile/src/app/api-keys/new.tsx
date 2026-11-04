import type { CreatedApiKey } from "@media/contracts/models/account";
import type { ApiKeyScope } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Check, KeyRound } from "lucide-react-native";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Toggle } from "@/components/ui/toggle";
import { KEY_PERMISSIONS } from "@/lib/account";
import { describeFailure } from "@/lib/failure";

const DEFAULT_SCOPES: ReadonlyArray<ApiKeyScope> = ["read", "play"];

const EXPIRES_IN_DAYS = 90;

const leave = () => (router.canGoBack() ? router.back() : router.replace("/api-keys"));

function Created({ created }: { readonly created: CreatedApiKey }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(created.secret);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    AccessibilityInfo.announceForAccessibility("Key copied");
    setCopied(true);
  };

  return (
    <Screen readable scroll header={<NavHeader title="API Key Created" onBack={leave} />}>
      <View className="h-6" />
      <Text variant="title" accessibilityRole="header">
        {created.apiKey.name}
      </Text>
      <Text tone="muted">Copy this key now. It won’t be shown again.</Text>
      <TextField
        label="API key"
        value={created.secret}
        editable={false}
        selectTextOnFocus
        numberOfLines={1}
      />
      <Button
        label={copied ? "Copied" : "Copy Key"}
        icon={copied ? Check : KeyRound}
        onPress={() => void copy()}
      />
      <Button label="Done" variant="secondary" onPress={leave} />
    </Screen>
  );
}

export default function CreateApiKey() {
  const viewer = useCommandQuery("account.viewer", {});
  const create = useCommand("apiKeys.create");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<ApiKeyScope>>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const held = viewer.status === "success" ? viewer.data.scopes : [];
  const grantable = KEY_PERMISSIONS.filter((permission) => held.includes(permission.scope));

  const chosen = scopes.filter((scope) =>
    grantable.some((permission) => permission.scope === scope),
  );

  if (created !== null) return <Created created={created} />;

  const submit = async () => {
    const trimmed = name.trim();

    if (trimmed === "") {
      setError("Name the key");

      return;
    }

    if (chosen.length === 0 || busy) return;
    setBusy(true);
    setError(null);

    try {
      setCreated(await create({ name: trimmed, scopes: chosen, expiresInDays: EXPIRES_IN_DAYS }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  const toggle = (scope: ApiKeyScope, on: boolean) =>
    setScopes((current) =>
      on
        ? [...current.filter((each) => each !== scope), scope]
        : current.filter((each) => each !== scope),
    );

  return (
    <Screen
      readable
      scroll
      header={
        <NavHeader
          title="Create API Key"
          fallback="/api-keys"
          trailing={
            <IconButton
              icon={Check}
              label="Create Key"
              disabled={busy || chosen.length === 0}
              onPress={() => void submit()}
            />
          }
        />
      }
    >
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        error={error}
        maxLength={80}
        autoCapitalize="words"
        returnKeyType="done"
        autoFocus
      />
      <Text variant="heading" accessibilityRole="header">
        Permissions
      </Text>
      {grantable.map((permission) => (
        <ListRow
          key={permission.scope}
          title={permission.label}
          trailing={
            <Toggle
              label={permission.label}
              value={chosen.includes(permission.scope)}
              onValueChange={(on) => toggle(permission.scope, on)}
            />
          }
        />
      ))}
      <Button
        label="Create Key"
        busy={busy}
        disabled={chosen.length === 0}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
