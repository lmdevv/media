/**
 * E08 · Accept an invite and create an account, from an invite link (`EntryLinksProvider`), or
 * G08 and its siblings when the link can't be used. Signing up flips the session phase and the
 * root stack moves to the app by itself. The server marks the invite used before sign-in ends, so
 * the form stays up while it does; a refusal keeps the form.
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { inviteLookup } from "@music/sdk/functions";
import type { InviteDetails } from "@music/sdk/functions";
import { useQuery } from "convex/react";
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
import { displayHost } from "@/lib/server";
import { useConnection } from "@/session/connection";

const TITLE = "You’re invited";

const trailing = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Users} />
  </View>
);

export default function Invite() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const lookup = useQuery(inviteLookup, { code });
  const [openedAt] = useState(Date.now);
  const [joining, setJoining] = useState(false);

  if (lookup === undefined)
    return (
      <Page title={TITLE} bottom="plain" trailing={trailing}>
        {null}
      </Page>
    );

  if (lookup.state === "invalid") return <LinkUnavailable kind="invite" state="invalid" />;

  const state = linkState(lookup, openedAt);

  if (state === "open" || joining) {
    return <AcceptInvite code={code} invite={lookup} onJoining={setJoining} />;
  }

  return <LinkUnavailable kind="invite" state={state} />;
}

/** The E08 form. */
function AcceptInvite({
  code,
  invite,
  onJoining,
}: {
  readonly code: string;
  readonly invite: InviteDetails;
  readonly onJoining: (joining: boolean) => void;
}) {
  const { signIn } = useAuthActions();
  const { origin } = useConnection();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invite.email ?? "");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const complete = name.trim() !== "" && email.trim() !== "" && password !== "";

  const submit = async () => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      setFailure(problem);

      return;
    }

    setPending(true);
    setFailure(null);
    onJoining(true);

    try {
      await signIn("password", {
        name: name.trim(),
        email: email.trim(),
        password,
        inviteCode: code,
        flow: "signUp",
      });
    } catch (cause) {
      onJoining(false);
      setFailure(accountFailureLine(cause));
      setPending(false);
    }
  };

  return (
    <Page title={TITLE} bottom="plain" trailing={trailing}>
      <Notice
        icon={Users}
        title={
          invite.inviterName === null ? "An invitation" : `An invitation from ${invite.inviterName}`
        }
        body={`Join ${displayHost(origin)}. You’ll have your own playlists, likes, and listening history.`}
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
        onSubmitEditing={() =>
          invite.email === null ? emailField.current?.focus() : passwordField.current?.focus()
        }
      />
      <Field
        ref={emailField}
        label="Email"
        value={email}
        onChangeText={setEmail}
        // The invite was made for this address; the server accepts no other.
        editable={invite.email === null}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="email"
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
