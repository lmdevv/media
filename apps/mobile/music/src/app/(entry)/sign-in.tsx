import { describeFailure, isFailure } from "@media/mobile-core/failure";
import { router } from "expo-router";
import { Airplay, Info, Key } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { View } from "react-native";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowCheck } from "@/components/ui/row";
import { displayHost } from "@/lib/server";
import { useConnection } from "@/session/connection";
import { useSessionPhase } from "@/session/session-phase";
import { useSignIn } from "@/session/sign-in";

const failureLine = (cause: unknown): string => {
  if (isFailure(cause, "Unauthenticated")) return "Username or password isn’t correct. Try again.";

  if (isFailure(cause, "RateLimited")) return "Too many attempts. Wait a minute and try again.";

  return describeFailure(cause);
};

/**
 * Who this app last signed in as on the server, whose password it asks for again once its own
 * session ended rather than using the phone's grant (D59); empty before anyone signed in here.
 */
const useLastUsername = (): string => {
  const phase = useSessionPhase();

  return phase.kind === "signedOut" ? (phase.person?.username ?? "") : "";
};

export default function SignIn() {
  const signIn = useSignIn();
  const { mediaUrl } = useConnection();
  const password = useRef<ComponentRef<typeof TextInput>>(null);
  const lastUsername = useLastUsername();
  const [username, setUsername] = useState(lastUsername);
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setFailure(null);

    try {
      await signIn.password({ username: username.trim(), password: secret });
    } catch (cause) {
      setFailure(failureLine(cause));
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
      <Row
        title={displayHost(mediaUrl)}
        subtitle="Your Lar server"
        leading={{ kind: "icon", icon: Airplay, tone: "muted" }}
        trailing={<RowCheck />}
      />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        textContentType="username"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect={false}
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
          disabled={username.trim() === "" || secret === ""}
          onPress={() => void submit()}
        />
      </View>
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
