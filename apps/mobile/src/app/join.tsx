import type { InviteLookup } from "@media/contracts/models/account";
import { PASSWORD_MIN_LENGTH } from "@media/contracts/models/account";
import { useAuth, useCommandQuery } from "@media/sdk/react";
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
import { describeFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useConnection, useServer } from "@/session/connection";
import { usePendingInvite } from "@/session/pending-invite";

type KnownInvite = Exclude<InviteLookup, { readonly state: "invalid" }>;

const ENDED = {
  expired: "Invite expired",
  used: "Invite already used",
  invalid: "Invite not valid",
} as const;

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

function AcceptInvite({ code, invite }: { readonly code: string; readonly invite: KnownInvite }) {
  const { signInWithPassword } = useAuth();
  const { setInvite } = usePendingInvite();
  const server = useServer();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invite.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = name.trim() !== "" && email.trim() !== "" && password !== "";

  const submit = async () => {
    if (!filled || busy) return;

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await signInWithPassword({
        flow: "signUp",
        name: name.trim(),
        email: (invite.email ?? email).trim(),
        password,
        inviteCode: code,
      });
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
        {`${invite.inviterName} invited you to\n${displayHost(server.mediaUrl)}.`}
      </Text>
      <TextField
        label="Your name"
        placeholder="Alex"
        value={name}
        onChangeText={setName}
        textContentType="name"
        autoComplete="name"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => emailField.current?.focus()}
      />
      <TextField
        ref={emailField}
        label="Email"
        placeholder="alex@example.com"
        value={invite.email ?? email}
        onChangeText={setEmail}
        editable={invite.email === null}
        autoCapitalize="none"
        keyboardType="email-address"
        textContentType="username"
        autoComplete="email"
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
  const { code, setInvite } = usePendingInvite();
  const lookup = useCommandQuery("invites.lookup", code === null ? "skip" : { code });

  if (code === null || lookup.status === "loading") {
    return (
      <Screen readable header={<NavHeader title="Join Household" onBack={() => setInvite(null)} />}>
        {null}
      </Screen>
    );
  }

  if (lookup.status === "error") {
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

  const invite = lookup.data;

  return invite.state === "open" ? (
    <AcceptInvite code={code} invite={invite} />
  ) : (
    <EndedInvite title={ENDED[invite.state]} />
  );
}
