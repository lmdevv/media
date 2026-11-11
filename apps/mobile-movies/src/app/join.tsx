import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Link } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { passwordProblem } from "@/lib/account";
import { describeFailure, isFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useConnection, useServer } from "@/session/connection";
import { usePendingInvite } from "@/session/pending-invite";
import { useSignIn } from "@/session/sign-in";

type Invite = Awaited<ReturnType<PlatformSdk["core"]["accounts"]["invites"]["lookup"]>>;

function EndedInvite({ title }: { readonly title: string }) {
  const { disconnect } = useConnection();
  const { setInvite } = usePendingInvite();

  return (
    <Screen readable header={<NavHeader onBack={() => setInvite(null)} />}>
      <CalmState
        placement="top"
        icon={Link}
        title={title}
        description="Ask the owner for a new invite."
        actions={
          <Button
            label="Connect to Server"
            onPress={() => {
              setInvite(null);
              disconnect();
            }}
          />
        }
      />
    </Screen>
  );
}

function AcceptInvite({ code, invite }: { readonly code: string; readonly invite: Invite }) {
  const signIn = useSignIn();
  const { setInvite } = usePendingInvite();
  const server = useServer();
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = username.trim() !== "" && password !== "";

  const submit = async () => {
    if (!filled || busy) return;

    const problem = passwordProblem(password);

    if (problem !== null) {
      setError(problem);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await signIn.acceptInvite({ code, username: username.trim(), password });
      setInvite(null);
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  return (
    <Screen
      readable
      scroll
      header={<NavHeader title="Join Household" onBack={() => setInvite(null)} />}
    >
      <Text variant="title" className="mt-12">
        {`${invite.invitedBy} invited you to\n${displayHost(server.mediaUrl)}.`}
      </Text>
      <TextField
        label="Username"
        placeholder="alex"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="username"
        autoComplete="username"
        returnKeyType="next"
        onSubmitEditing={() => passwordField.current?.focus()}
      />
      <TextField
        ref={passwordField}
        label="Password"
        placeholder="Create a password"
        value={password}
        onChangeText={(text) => {
          setPassword(text);
          setError(null);
        }}
        error={error}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button label="Create Account" busy={busy} disabled={!filled} onPress={() => void submit()} />
      <Button
        label="I Already Have an Account"
        variant="secondary"
        onPress={() => setInvite(null)}
      />
    </Screen>
  );
}

export default function Join() {
  const platform = usePlatform();
  const { code, setInvite } = usePendingInvite();

  const lookup = usePlatformQuery(
    platform.core.accounts.invites.lookup,
    ...(code === null ? (["skip"] as const) : [{ code }]),
  );

  if (code === null || lookup.status === "loading") {
    return (
      <Screen readable header={<NavHeader title="Join Household" onBack={() => setInvite(null)} />}>
        {null}
      </Screen>
    );
  }

  if (lookup.status === "error") {
    if (isFailure(lookup.error, "Expired")) return <EndedInvite title="Invite expired" />;

    if (isFailure(lookup.error, "NotFound") || isFailure(lookup.error, "InvalidArgs")) {
      return <EndedInvite title="Invite not valid" />;
    }

    return (
      <Screen readable header={<NavHeader onBack={() => setInvite(null)} />}>
        <CalmState
          placement="top"
          icon={Link}
          title="Can’t open invite"
          description={describeFailure(lookup.error)}
          actions={<Button label="Try Again" onPress={lookup.retry} />}
        />
      </Screen>
    );
  }

  return <AcceptInvite code={code} invite={lookup.data} />;
}
