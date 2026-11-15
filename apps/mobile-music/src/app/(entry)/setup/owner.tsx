import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Info } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { View } from "react-native";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { accountFailureLine, passwordProblem } from "@/lib/account-form";
import { useSetupProgress } from "@/session/session-phase";
import { useSignIn } from "@/session/sign-in";

export default function CreateOwner() {
  const signIn = useSignIn();
  const platform = usePlatform();
  const { setProgress } = useSetupProgress();
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
    setProgress("creatingOwner");

    try {
      await signIn.setUpOwner({ username: username.trim(), password });
    } catch (cause) {
      setProgress("none");
      setFailure(accountFailureLine(cause));
      setPending(false);

      return;
    }

    // The name you go by; the account works without it, so a failure here stops nothing.
    await platform.core.accounts.me.setDisplayName({ displayName: name.trim() }).catch(() => null);
  };

  return (
    <Page
      title="Make it yours"
      bottom="plain"
      onBack={() => router.push("/change-server")}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Info} />
        </View>
      }
    >
      <Text variant="mono" tone="muted">
        SETUP · 1 OF 3
      </Text>
      <Text variant="hero" accessibilityRole="header" className="pt-5">
        {"Your music,\nyour server."}
      </Text>
      <Text tone="muted" className="pt-3">
        Create the first account. You’ll be the server owner.
      </Text>
      <Field
        label="Name"
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
        label="Password"
        helper="Use at least 8 characters."
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
          label="Create account"
          pendingLabel="Creating account…"
          pending={pending}
          disabled={!complete}
          onPress={() => void submit()}
        />
      </View>
    </Page>
  );
}
