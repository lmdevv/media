import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Key } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { LinkUnavailable } from "@/components/entry/link-unavailable";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { accountFailureLine, passwordProblem } from "@/lib/account-form";
import { linkState } from "@/lib/link-state";
import type { Answer } from "@/lib/models";
import { useReadSettled } from "@/lib/platform";
import { useSignIn } from "@/session/sign-in";

type PasswordResetDetails = Answer<
  ReturnType<typeof usePlatform>["core"]["accounts"]["resetLinks"]["lookup"]
>;

const TITLE = "Reset password";

const trailing = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Key} />
  </View>
);

export default function ResetPassword() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const lookup = useReadSettled(usePlatform().core.accounts.resetLinks.lookup, { code: token });
  const [openedAt] = useState(Date.now);
  const [held, setHeld] = useState<PasswordResetDetails | null>(null);
  const state = linkState(lookup, openedAt);

  // Resetting spends the link, so the form stays while the core reports it gone.
  if (held !== null) return <ResetForm token={token} reset={held} onResetting={setHeld} />;

  if (state === "loading")
    return (
      <Page title={TITLE} bottom="plain" trailing={trailing}>
        {null}
      </Page>
    );

  if (state === "open" && lookup !== undefined && !(lookup instanceof Error)) {
    return <ResetForm token={token} reset={lookup} onResetting={setHeld} />;
  }

  return <LinkUnavailable kind="reset" state={state === "open" ? "invalid" : state} />;
}

function ResetForm({
  token,
  reset,
  onResetting,
}: {
  readonly token: string;
  readonly reset: PasswordResetDetails;
  readonly onResetting: (reset: PasswordResetDetails | null) => void;
}) {
  const signIn = useSignIn();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      setFailure(problem);

      return;
    }

    setPending(true);
    setFailure(null);
    onResetting(reset);

    try {
      await signIn.resetPassword({ code: token, password });
    } catch (cause) {
      onResetting(null);
      setFailure(accountFailureLine(cause));
      setPending(false);
    }
  };

  return (
    <Page title={TITLE} bottom="plain" trailing={trailing}>
      <Text variant="hero" accessibilityRole="header" className="pt-12 pb-4">
        A fresh start.
      </Text>
      <Text tone="muted">{`Choose a new password for ${reset.username}.`}</Text>
      <Field
        label="New password"
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
          if (password !== "") void submit();
        }}
      />
      <View className="pt-6">
        <Button
          label="Reset password"
          pendingLabel="Resetting…"
          pending={pending}
          disabled={password === ""}
          onPress={() => void submit()}
        />
      </View>
      <Notice
        icon={Key}
        title="One-time reset link"
        body="This link was created by your server admin and expires after 24 hours."
        className="mt-5"
      />
    </Page>
  );
}
