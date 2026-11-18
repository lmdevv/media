import { roleLabel } from "@/lib/capabilities";
import { nameOf } from "@/lib/models";
import type { Me } from "@/lib/models";
import { useCore } from "@/lib/platform";
import { isBlank } from "@/lib/text";
import { Check, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { hostOf } from "@/lib/links";
import { useConnection } from "@/session/connection";
import { useSignOut } from "@/session/sign-out";

import { useMe } from "./access";
import { Failure } from "./failure";
import { useAction } from "./use-action";
import { useFlash } from "./use-flash";

function AccountForm({ me }: { readonly me: Me }) {
  const { mediaUrl } = useConnection();
  const signOut = useSignOut();
  const core = useCore();
  const save = useAction();
  const leave = useAction();
  const [saved, flashSaved] = useFlash();
  const [name, setName] = useState(me.displayName ?? "");
  const unchanged = name.trim() === (me.displayName ?? "");
  const blocked = isBlank(name) || unchanged;

  const submit = () => {
    if (blocked) return;

    save.run(async () => {
      await core.accounts.me.setDisplayName({ displayName: name.trim() });
      flashSaved();
    });
  };

  return (
    <Page
      title="Account"
      bottom="plain"
      trailing={<IconButton icon={Check} label="Save name" disabled={blocked} onPress={submit} />}
    >
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={nameOf(me)}
        subtitle={`${roleLabel(me.role)} · ${hostOf(mediaUrl)}`}
      />
      <Field
        label="Display name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        textContentType="name"
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <Field
        label="Username"
        value={me.username}
        editable={false}
        selectTextOnFocus
        helper="Your sign-in name."
      />
      <Failure message={save.failure} />
      <View className="pt-6">
        <Button
          label={saved ? "Saved" : "Save name"}
          pendingLabel="Saving…"
          pending={save.pending}
          disabled={blocked && !saved}
          onPress={submit}
        />
      </View>
      <View className="pt-8">
        <Button
          label="Sign out"
          variant="secondary"
          pendingLabel="Signing out…"
          pending={leave.pending}
          onPress={() => leave.run(signOut)}
        />
      </View>
      <Failure message={leave.failure} />
    </Page>
  );
}

/** F02, with an empty page while the account loads. */
export function AccountSettings() {
  const me = useMe();

  if (me === null)
    return (
      <Page title="Account" bottom="plain">
        {null}
      </Page>
    );

  return <AccountForm me={me} />;
}
