import { useAllPages } from "@media/mobile-core/pages";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Key, Lock, Plus, Share } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { ApiKeyId } from "@/lib/ids";
import type { Row as RowOf } from "@/lib/models";
import { useCore } from "@/lib/platform";
import { isBlank } from "@/lib/text";
import { ago } from "@/lib/when";
import { useMe } from "@/session/me";

import { copyText } from "./clipboard";
import { Failure } from "./failure";
import { Headline } from "./headline";
import { holdSecret, useHeldSecret } from "./secret-slot";
import { NavGlyph } from "./nav-glyph";
import { useAction } from "./use-action";
import { useFlash } from "./use-flash";
import { useNow } from "./use-now";
import { ValueField } from "./value-field";

type ApiKey = RowOf<ReturnType<typeof useCore>["auth"]["apiKeys"]["list"]>;

const keyLine = (key: ApiKey, now: number): string =>
  key.lastUsedAt === null ? "Never used" : `Used ${ago(key.lastUsedAt, now)}`;

/** Keys asked for per page; a person keeps few. */
const KEY_ROWS = 100;

/** Every key you made that still works or ran out, newest first; undefined while they load. */
const useKeys = (): ReadonlyArray<ApiKey> | undefined => {
  const core = useCore();

  const paged = useAllPages(
    core.auth.apiKeys.list,
    (paginationOpts) => ({ paginationOpts }),
    KEY_ROWS,
  );

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready" || paged.next.kind !== "done") return undefined;

  return paged.rows;
};

const openNewKey = () => router.push("/settings/keys/new");

/** F04, or G16 when there are no keys yet. */
export function KeyList() {
  const keys = useKeys();
  const now = useNow(60_000);
  const add = <IconButton icon={Plus} label="Create API key" onPress={openNewKey} />;

  if (keys === undefined)
    return (
      <Page title="API keys" bottom="plain">
        {null}
      </Page>
    );

  if (keys.length === 0) {
    return (
      <Page title="API keys" bottom="plain" trailing={add}>
        <EmptyState
          icon={Key}
          title={"Your agents\ncan listen too."}
          body={"Create a key for the [music] CLI\nor your personal assistant."}
          primary={<Button label="Create API key" icon={Plus} onPress={openNewKey} />}
        />
      </Page>
    );
  }

  return (
    <Page title="API keys" bottom="plain" trailing={add}>
      <Text tone="muted" className="pb-mobile-edge">
        Let your CLI and agents act for you.
      </Text>
      {keys.map((key) => (
        <Row
          key={key.keyId}
          leading={{ kind: "icon", icon: Key, tone: "muted" }}
          title={key.name}
          subtitle={keyLine(key, now)}
          trailing={<RowChevron />}
          accessibilityLabel={`${key.name}, ${keyLine(key, now)}. Revoke`}
          onPress={() => router.push(`/settings/keys/${key.keyId}/revoke`)}
        />
      ))}
      <Notice
        icon={Lock}
        title="Your account, your permissions"
        body="Keys have the same access as you. You can revoke them at any time."
      />
      <View className="pt-6">
        <Button label="Create API key" icon={Plus} onPress={openNewKey} />
      </View>
    </Page>
  );
}

/** F05: name a key, then F06 shows it. */
export function NewKey() {
  const core = useCore();
  const me = useMe();
  const action = useAction();
  const [name, setName] = useState("");

  const submit = () => {
    if (isBlank(name)) return;

    action.run(async () => {
      // A key has the same access as you: every scope this session holds.
      const { key } = await core.auth.apiKeys.create({ name: name.trim(), scopes: [...me.scopes] });

      holdSecret(key);
      router.replace({ pathname: "/settings/keys/created", params: { name: name.trim() } });
    });
  };

  return (
    <Page title="New API key" bottom="plain" trailing={<NavGlyph icon={Key} />}>
      <Headline top="regular">{"Give your agent\na way in."}</Headline>
      <Field
        label="Key name"
        value={name}
        onChangeText={setName}
        placeholder="Library assistant"
        helper="Choose a name you’ll recognize later."
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <Failure message={action.failure} />
      <View className="pt-6">
        <Button
          label="Create key"
          pendingLabel="Creating…"
          pending={action.pending}
          disabled={isBlank(name)}
          onPress={submit}
        />
      </View>
    </Page>
  );
}

const decodeName = Schema.decodeUnknownOption(Schema.String);

/**
 * F06: the new key, once. F05 left it in the secret slot, which this screen empties on its first
 * render, so leaving and coming back never shows it again.
 */
export function CreatedKey() {
  const key = useHeldSecret();
  const name = Option.getOrElse(decodeName(useLocalSearchParams().name), () => "API key");
  const [copied, flashCopied] = useFlash();

  return (
    <Page title="Save your key" bottom="plain" trailing={<NavGlyph icon={Key} />}>
      {key === null ? (
        <EmptyState
          icon={Key}
          title="The key was shown once."
          body="If you didn’t save it, revoke it and create another."
          primary={<Button label="Back to API keys" onPress={() => router.back()} />}
        />
      ) : (
        <>
          <Notice
            icon={Key}
            title="Shown only once"
            body="Copy this key now. After you leave this screen, you can’t reveal it again."
          />
          <ValueField label={name} value={key} wrap />
          <View className="pt-6">
            <Button
              label={copied ? "Copied" : "Copy API key"}
              icon={Share}
              onPress={() => {
                void copyText(key).then(flashCopied);
              }}
            />
          </View>
          <View className="pt-4">
            <Button label="I’ve saved it" variant="secondary" onPress={() => router.back()} />
          </View>
        </>
      )}
    </Page>
  );
}

const decodeKeyId = Schema.decodeUnknownOption(ApiKeyId);

/** F07: revoke one key at once. */
export function RevokeKey() {
  const id = Option.getOrNull(decodeKeyId(useLocalSearchParams().id));
  const keys = useKeys();
  const core = useCore();
  const key = keys?.find((candidate) => candidate.keyId === id);

  if (id === null || key === undefined) return null;

  return (
    <ConfirmSheet
      title={`Revoke ${key.name}?`}
      body="The CLI or agent using this key will lose access immediately."
      confirmLabel="Revoke key"
      pendingLabel="Revoking…"
      cancelLabel="Keep key"
      onConfirm={async () => {
        await core.auth.apiKeys.revoke({ keyId: key.keyId });
        router.back();
      }}
    />
  );
}
