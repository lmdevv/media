import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { passwordProblem } from "@/lib/account";
import { describeFailure } from "@/lib/failure";
import { useConnection } from "@/session/connection";
import { useFirstRun } from "@/session/first-run";
import { useSignIn } from "@/session/sign-in";
import type { SetupStart } from "@/session/first-run";

export default function CreateOwnerAccount() {
  const signIn = useSignIn();
  const { disconnect } = useConnection();
  const firstRun = useFirstRun();
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SetupStart | null>(null);
  const submitting = useRef(false);
  const ready = username.trim() !== "" && password !== "" && busy === null;

  const create = async (start: SetupStart) => {
    if (!ready || submitting.current) return;

    const problem = passwordProblem(password);

    if (problem !== null) {
      setPasswordError(problem);

      return;
    }

    submitting.current = true;
    setBusy(start);
    setError(null);
    firstRun.begin(start);

    try {
      await signIn.setUpOwner({ username: username.trim(), password });
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
        label="Username"
        placeholder="alex"
        value={username}
        onChangeText={(text) => {
          setUsername(text);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="username"
        autoComplete="username"
        returnKeyType="next"
        className="mt-6"
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
