import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Users } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { View } from "react-native";
import type { TextInput } from "react-native";

import { LinkUnavailable } from "@/components/entry/link-unavailable";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { accountFailureLine, passwordProblem } from "@/lib/account-form";
import { linkState } from "@/lib/link-state";
import type { Answer } from "@/lib/models";
import { useReadSettled } from "@/lib/platform";
import { displayHost } from "@/lib/server";
import { useConnection } from "@/session/connection";
import { useSignIn } from "@/session/sign-in";

type InviteDetails = Answer<
  ReturnType<typeof usePlatform>["core"]["accounts"]["invites"]["lookup"]
>;

const TITLE = "You’re invited";

const trailing = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Users} />
  </View>
);

export default function Invite() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const lookup = useReadSettled(usePlatform().core.accounts.invites.lookup, { code });
  const [openedAt] = useState(Date.now);
  const [held, setHeld] = useState<InviteDetails | null>(null);
  const state = linkState(lookup, openedAt);

  // Signing up spends the invite, so the form stays while the core reports it gone.
  if (held !== null) return <AcceptInvite code={code} invite={held} onJoining={setHeld} />;

  if (state === "loading")
    return (
      <Page title={TITLE} bottom="plain" trailing={trailing}>
        {null}
      </Page>
    );

  if (state === "open" && lookup !== undefined && !(lookup instanceof Error)) {
    return <AcceptInvite code={code} invite={lookup} onJoining={setHeld} />;
  }

  return <LinkUnavailable kind="invite" state={state === "open" ? "invalid" : state} />;
}

function AcceptInvite({
  code,
  invite,
  onJoining,
}: {
  readonly code: string;
  readonly invite: InviteDetails;
  readonly onJoining: (invite: InviteDetails | null) => void;
}) {
  const signIn = useSignIn();
  const platform = usePlatform();
  const { mediaUrl } = useConnection();
  const usernameField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const complete = name.trim() !== "" && username.trim() !== "" && password !== "";

  const submit = async () => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      setFailure(problem);

      return;
    }

    setPending(true);
    setFailure(null);
    onJoining(invite);

    try {
      await signIn.acceptInvite({ code, username: username.trim(), password });
    } catch (cause) {
      onJoining(null);
      setFailure(accountFailureLine(cause));
      setPending(false);

      return;
    }

    // The name you go by; the account works without it, so a failure here stops nothing.
    await platform.core.accounts.me.setDisplayName({ displayName: name.trim() }).catch(() => null);
  };

  return (
    <Page title={TITLE} bottom="plain" trailing={trailing}>
      <Notice
        icon={Users}
        title={`An invitation from ${invite.invitedBy}`}
        body={`Join ${displayHost(mediaUrl)}. You’ll have your own playlists, likes, and listening history.`}
      />
      <Field
        label="Your name"
        value={name}
        onChangeText={setName}
        textContentType="name"
        autoComplete="name"
        autoCapitalize="words"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => usernameField.current?.focus()}
      />
      <Field
        ref={usernameField}
        label="Username"
        value={username}
        onChangeText={setUsername}
        textContentType="username"
        autoComplete="username"
        autoCapitalize="none"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordField.current?.focus()}
      />
      <Field
        ref={passwordField}
        label="Choose a password"
        helper="At least 8 characters."
        value={password}
        onChangeText={(text) => {
          setPassword(text);
          setFailure(null);
        }}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        returnKeyType="go"
        error={failure}
        onSubmitEditing={() => {
          if (complete) void submit();
        }}
      />
      <View className="pt-6">
        <Button
          label="Accept invite"
          pendingLabel="Joining…"
          pending={pending}
          disabled={!complete}
          onPress={() => void submit()}
        />
      </View>
    </Page>
  );
}
