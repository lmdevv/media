import { usePlatform } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Check } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Alert } from "react-native";
import type { TextInput } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { PASSWORD_MAX, PASSWORD_MIN, passwordProblem } from "@/lib/account";
import { describeFailure, isFailure } from "@/lib/failure";

type Problem = { readonly field: "current" | "next" | "confirm"; readonly message: string };

const checkForm = (current: string, next: string, confirm: string): Problem | null => {
  if (current === "") return { field: "current", message: "Enter your current password" };

  const weak = passwordProblem(next);

  if (weak !== null) return { field: "next", message: weak };

  if (confirm !== next) return { field: "confirm", message: "Passwords don’t match" };

  return null;
};

export default function ChangePassword() {
  const platform = usePlatform();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const nextField = useRef<ComponentRef<typeof TextInput>>(null);
  const confirmField = useRef<ComponentRef<typeof TextInput>>(null);

  const save = async () => {
    const refused = checkForm(current, next, confirm);

    setProblem(refused);

    if (refused !== null || busy) return;
    setBusy(true);

    try {
      await platform.core.accounts.me.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Password Changed", "Your other devices were signed out.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (cause) {
      setProblem(
        isFailure(cause, "Unauthenticated") || isFailure(cause, "RateLimited")
          ? { field: "current", message: describeFailure(cause) }
          : { field: "next", message: describeFailure(cause) },
      );
      setBusy(false);
    }
  };

  const errorFor = (field: Problem["field"]): string | null =>
    problem?.field === field ? problem.message : null;

  return (
    <Screen
      readable
      scroll
      header={
        <NavHeader
          title="Change Password"
          fallback="/account"
          trailing={
            <IconButton
              icon={Check}
              label="Save Password"
              disabled={busy}
              onPress={() => void save()}
            />
          }
        />
      }
    >
      <TextField
        label="Current Password"
        value={current}
        onChangeText={setCurrent}
        error={errorFor("current")}
        secureTextEntry
        textContentType="password"
        autoComplete="current-password"
        autoCapitalize="none"
        returnKeyType="next"
        onSubmitEditing={() => nextField.current?.focus()}
        autoFocus
      />
      <TextField
        ref={nextField}
        label="New Password"
        value={next}
        onChangeText={setNext}
        error={errorFor("next")}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        autoCapitalize="none"
        passwordRules={`minlength: ${PASSWORD_MIN}; maxlength: ${PASSWORD_MAX};`}
        returnKeyType="next"
        onSubmitEditing={() => confirmField.current?.focus()}
      />
      <TextField
        ref={confirmField}
        label="Confirm New Password"
        value={confirm}
        onChangeText={setConfirm}
        error={errorFor("confirm")}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      <Button label="Save Password" busy={busy} onPress={() => void save()} />
    </Screen>
  );
}
