/**
 * E04 · Create the owner on a server with nobody on it yet (setup 1 of 3). The server counts its
 * first person before sign-up returns, so the session holds this screen until the new owner is
 * signed in; the root stack then moves on to adding music (E05). A refusal keeps the form.
 */
import { useAuthActions } from "@convex-dev/auth/react";
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

export default function CreateOwner() {
  const { signIn } = useAuthActions();
  const { setProgress } = useSetupProgress();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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
    setProgress("creatingOwner");

    try {
      await signIn("password", {
        name: name.trim(),
        email: email.trim(),
        password,
        flow: "signUp",
      });
    } catch (cause) {
      setProgress("none");
      setFailure(accountFailureLine(cause));
      setPending(false);
    }
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
        onSubmitEditing={() => emailField.current?.focus()}
      />
      <Field
        ref={emailField}
        label="Email"
        value={email}
        onChangeText={setEmail}
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
