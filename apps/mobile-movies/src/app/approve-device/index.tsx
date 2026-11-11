import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { USER_CODE_LENGTH, codeLetters, formatUserCode } from "@/lib/device-code";

const shown = (letters: string): string =>
  letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;

export default function ApproveDevice() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [letters, setLetters] = useState(() => codeLetters(params.code ?? ""));
  const userCode = formatUserCode(letters);

  const next = () => {
    if (userCode !== null) {
      router.push({ pathname: "/approve-device/[userCode]", params: { userCode } });
    }
  };

  return (
    <Screen readable scroll header={<NavHeader title="Approve a Device" fallback="/you" />}>
      <View className="h-12" />
      <TextField
        label="Device code"
        value={shown(letters)}
        onChangeText={(typed) => setLetters(codeLetters(typed))}
        autoCapitalize="characters"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={USER_CODE_LENGTH + 1}
        returnKeyType="go"
        onSubmitEditing={next}
        autoFocus={letters === ""}
      />
      <Button label="Continue" disabled={userCode === null} onPress={next} />
      <Button
        label="Scan QR Code"
        variant="secondary"
        onPress={() => router.push("/approve-device/scan")}
      />
    </Screen>
  );
}
