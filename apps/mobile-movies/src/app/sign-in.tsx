import { router } from "expo-router";
import { Server } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { describeFailure, isFailure } from "@/lib/failure";
import { useConnection, useServer } from "@/session/connection";
import { useSessionPhase } from "@/session/session-phase";
import { useSignIn } from "@/session/sign-in";

export default function SignIn() {
  const signIn = useSignIn();
  const { disconnect } = useConnection();
  const server = useServer();
  const phase = useSessionPhase();
  const password = useRef<ComponentRef<typeof TextInput>>(null);

  // An app whose own session ended asks its person for the password again (D59).
  const [username, setUsername] = useState(
    phase.kind === "signedOut" ? (phase.person?.username ?? "") : "",
  );

  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = username.trim() !== "" && secret !== "" && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);

    try {
      await signIn.password({ username: username.trim(), password: secret });
    } catch (cause) {
      setError(
        isFailure(cause, "Unauthenticated")
          ? "Username or password is incorrect."
          : describeFailure(cause),
      );
      setBusy(false);
    }
  };

  return (
    <Screen
      readable
      scroll
      header={<NavHeader title="Sign In" onBack={disconnect} />}
      contentClassName="regular:justify-center regular:pb-24"
    >
      <ListRow
        icon={Server}
        title={new URL(server.mediaUrl).host}
        detail="Connected"
        onPress={disconnect}
      />
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
        onSubmitEditing={() => password.current?.focus()}
        className="mt-10"
      />
      <TextField
        ref={password}
        label="Password"
        value={secret}
        onChangeText={(text) => {
          setSecret(text);
          setError(null);
        }}
        error={error}
        secureTextEntry
        textContentType="password"
        autoComplete="current-password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button
        label={error === null ? "Sign In" : "Try Again"}
        busy={busy}
        disabled={username.trim() === "" || secret === ""}
        onPress={() => void submit()}
      />
      <Button
        label="Sign In with a Code"
        variant="secondary"
        onPress={() => router.push("/sign-in-code")}
      />
    </Screen>
  );
}
