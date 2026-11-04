import { PASSWORD_MIN_LENGTH } from "@media/contracts/models/account";
import { useAuth } from "@media/sdk/react";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { describeFailure } from "@/lib/failure";
import { useConnection } from "@/session/connection";
import { useFirstRun } from "@/session/first-run";
import type { SetupStart } from "@/session/first-run";

export default function CreateOwnerAccount() {
  const { signInWithPassword } = useAuth();
  const { disconnect } = useConnection();
  const firstRun = useFirstRun();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SetupStart | null>(null);
  const submitting = useRef(false);
  const ready = name.trim() !== "" && email.trim() !== "" && password !== "" && busy === null;

  const create = async (start: SetupStart) => {
    if (!ready || submitting.current) return;

    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);

      return;
    }

    submitting.current = true;
    setBusy(start);
    setError(null);
    firstRun.begin(start);

    try {
      await signInWithPassword({
        flow: "signUp",
        name: name.trim(),
        email: email.trim(),
        password,
      });
    } catch (cause) {
      firstRun.end();
      setError(describeFailure(cause));
      setBusy(null);
      submitting.current = false;
    }
  };

  return (
    <Screen readable scroll header={<NavHeader title="Create Owner Account" onBack={disconnect} />}>
      <TextField
        label="Name"
        placeholder="Alex"
        value={name}
        onChangeText={(text) => {
          setName(text);
          setError(null);
        }}
        autoCapitalize="words"
        textContentType="name"
        autoComplete="name"
        returnKeyType="next"
        onSubmitEditing={() => emailField.current?.focus()}
        className="mt-6"
      />
      <TextField
        ref={emailField}
        label="Email"
        placeholder="alex@example.com"
        value={email}
        onChangeText={(text) => {
          setEmail(text);
          setError(null);
        }}
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
          setPasswordError(null);
          setError(null);
        }}
        error={passwordError}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        returnKeyType="go"
        onSubmitEditing={() => void create("library")}
      />
      {error === null ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Button
        label="Create Account"
        busy={busy === "library"}
        disabled={!ready && busy !== "library"}
        onPress={() => void create("library")}
      />
      <Button
        label="Import from Jellyfin or Plex"
        variant="secondary"
        busy={busy === "import"}
        disabled={!ready && busy !== "import"}
        onPress={() => void create("import")}
      />
    </Screen>
  );
}
