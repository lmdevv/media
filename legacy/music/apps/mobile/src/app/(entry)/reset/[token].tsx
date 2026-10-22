/**
 * E09 · Choose a new password from an admin's one-time reset link (`EntryLinksProvider`), or why
 * the link can't be used. Setting it signs the person in, and the root stack moves to the app by
 * itself. The server marks the link used before sign-in ends, so the form stays up while it does;
 * a refusal keeps the form.
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { passwordResetLookup } from "@music/sdk/functions";
import type { PasswordResetDetails } from "@music/sdk/functions";
import { useQuery } from "convex/react";
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

const TITLE = "Reset password";

const trailing = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Key} />
  </View>
);

export default function ResetPassword() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const lookup = useQuery(passwordResetLookup, { token });
  const [openedAt] = useState(Date.now);
  const [resetting, setResetting] = useState(false);

  if (lookup === undefined)
    return (
      <Page title={TITLE} bottom="plain" trailing={trailing}>
        {null}
      </Page>
    );

  if (lookup.state === "invalid") return <LinkUnavailable kind="reset" state="invalid" />;

  const state = linkState(lookup, openedAt);

  if (state === "open" || resetting) {
    return <ResetForm token={token} reset={lookup} onResetting={setResetting} />;
  }

  return <LinkUnavailable kind="reset" state={state} />;
}

/** The E09 form. */
function ResetForm({
  token,
  reset,
  onResetting,
}: {
  readonly token: string;
  readonly reset: PasswordResetDetails;
  readonly onResetting: (resetting: boolean) => void;
}) {
  const { signIn } = useAuthActions();
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
    onResetting(true);

    try {
      await signIn("password", { flow: "reset", token, newPassword: password });
    } catch (cause) {
      onResetting(false);
      setFailure(accountFailureLine(cause));
      setPending(false);
    }
  };

  return (
    <Page title={TITLE} bottom="plain" trailing={trailing}>
      <Text variant="hero" accessibilityRole="header" className="pt-12 pb-4">
        A fresh start.
      </Text>
      <Text tone="muted">{`Choose a new password for ${reset.email}.`}</Text>
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
