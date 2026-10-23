/**
 * F02 · Account: who is signed in, their display name to change, the email they sign in with,
 * and Sign out. Signing out ends the session; the root stack then shows Sign in on its own.
 */
import type { User } from "@music/commands/models";
import { roleLabel } from "@music/commands/permissions";
import { isBlank } from "@music/commands/text";
import { useRun } from "@music/sdk/react";
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

/** The account form, once the account has loaded. */
function AccountForm({ me }: { readonly me: User }) {
  const { origin } = useConnection();
  const signOut = useSignOut();
  const rename = useRun("account.rename");
  const save = useAction();
  const leave = useAction();
  const [saved, flashSaved] = useFlash();
  const [name, setName] = useState(me.name ?? "");
  const unchanged = name.trim() === (me.name ?? "");
  const blocked = isBlank(name) || unchanged;

  const submit = () => {
    if (blocked) return;

    save.run(async () => {
      await rename({ name });
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
        title={me.name ?? me.email}
        subtitle={`${roleLabel(me.role)} · ${hostOf(origin)}`}
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
        label="Email"
        value={me.email}
        editable={false}
        selectTextOnFocus
        helper="Your sign-in email."
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

  if (me === undefined)
    return (
      <Page title="Account" bottom="plain">
        {null}
      </Page>
    );

  return <AccountForm me={me} />;
}
