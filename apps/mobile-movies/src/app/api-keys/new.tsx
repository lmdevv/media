import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform } from "@media/sdk/react";
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
import { broadestLabel, grantablePermissions } from "@/lib/api-keys";
import type { KeyScope } from "@/lib/api-keys";
import { useMadeKeys } from "@/session/made-keys";
import { useMe } from "@/session/me";

const DEFAULT_SCOPES: ReadonlyArray<KeyScope> = ["movies:read", "movies:play"];

const EXPIRES_IN_DAYS = 90;

const leave = () => (router.canGoBack() ? router.back() : router.replace("/api-keys"));

interface CreatedKey {
  readonly name: string;
  /** The key itself, shown once. */
  readonly key: string;
}

function Created({ created }: { readonly created: CreatedKey }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(created.key);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    AccessibilityInfo.announceForAccessibility("Key copied");
    setCopied(true);
  };

  return (
    <Screen readable scroll header={<NavHeader title="API Key Created" onBack={leave} />}>
      <View className="h-6" />
      <Text variant="title" accessibilityRole="header">
        {created.name}
      </Text>
      <Text tone="muted">Copy this key now. It won’t be shown again.</Text>
      <TextField
        label="API key"
        value={created.key}
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
  const me = useMe();
  const platform = usePlatform();
  const made = useMadeKeys();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<KeyScope>>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const grantable = grantablePermissions(me.scopes);

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
      const key = await platform.core.auth.apiKeys.create({
        name: trimmed,
        scopes: chosen,
        expiresInDays: EXPIRES_IN_DAYS,
      });

      made.add({ keyId: key.keyId, name: trimmed, detail: broadestLabel(chosen) });
      setCreated({ name: trimmed, key: key.key });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  const toggle = (scope: KeyScope, on: boolean) =>
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
