/**
 * E03 · Sign in, and its error variant G07. Signing in flips the session phase, and the root
 * stack moves to the app by itself. A refusal keeps both fields and says so under the form
 * without blaming either field (G07); the server's own explanations (a suspended account, too
 * many attempts) show as it words them.
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { commandFailure } from "@music/sdk/errors";
import { signInFailure } from "@music/sdk/sign-in";
import type { SignInFailure } from "@music/sdk/sign-in";
import { router } from "expo-router";
import { Airplay, Info, Key } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { View } from "react-native";
import type { TextInput } from "react-native";

import { EndedNotice } from "@/components/states/ended-notice";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowCheck } from "@/components/ui/row";
import { displayHost } from "@/lib/server";
import { useConnection } from "@/session/connection";

const FAILURE_LINES = {
  credentials: "Email or password isn’t correct. Try again.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  server: "Couldn’t sign in. The server reported an error.",
} as const satisfies Record<SignInFailure, string>;

/** The line under the form for a failed sign-in. */
const failureLine = (cause: Error | null): string => {
  if (cause === null) return FAILURE_LINES.server;

  const failure = commandFailure(cause);
  const kind = signInFailure(cause);

  if (failure !== null && kind !== "credentials") return failure.message;

  return FAILURE_LINES[kind];
};

export default function SignIn() {
  const { signIn } = useAuthActions();
  const { origin } = useConnection();
  const password = useRef<ComponentRef<typeof TextInput>>(null);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setFailure(null);

    try {
      await signIn("password", { email: email.trim(), password: secret, flow: "signIn" });
    } catch (cause) {
      setFailure(failureLine(cause instanceof Error ? cause : null));
      setPending(false);
    }
  };

  return (
    <Page
      title="Welcome back"
      bottom="plain"
      onBack={() => router.push("/change-server")}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Info} />
        </View>
      }
    >
      <EndedNotice />
      <Row
        title={displayHost(origin)}
        subtitle="Your [music] server"
        leading={{ kind: "icon", icon: Airplay, tone: "muted" }}
        trailing={<RowCheck />}
      />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="email"
        autoCapitalize="none"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => password.current?.focus()}
      />
      <Field
        ref={password}
        label="Password"
        value={secret}
        onChangeText={(text) => {
          setSecret(text);
          setFailure(null);
        }}
        secureTextEntry
        textContentType="password"
        autoComplete="current-password"
        returnKeyType="go"
        error={failure}
        onSubmitEditing={() => void submit()}
      />
      <View className="pt-6">
        <Button
          label="Sign in"
          pendingLabel="Signing in…"
          pending={pending}
          disabled={email.trim() === "" || secret === ""}
          onPress={() => void submit()}
        />
      </View>
      {/* After a refusal the hint turns to the reset link itself (G07). */}
      <Notice
        icon={Key}
        title={failure === null ? "Need to reset your password?" : "Need a reset link?"}
        body={
          failure === null
            ? "Ask your server admin for a password reset link."
            : "Ask your server admin to create one for you."
        }
        className="mt-6"
      />
      <View className="pt-4">
        <Button
          label="Use a different server"
          variant="secondary"
          onPress={() => router.push("/change-server")}
        />
      </View>
    </Page>
  );
}
