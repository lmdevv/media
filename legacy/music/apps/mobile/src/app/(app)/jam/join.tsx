/**
 * D12 · Join a Jam by its link or code, typed or pasted, or by scanning the host's QR code. A good
 * code opens its invite (D05), which says when the Jam can't be joined (G11, G12).
 */
import { router } from "expo-router";
import { Info, QrCode } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { jamNavGlyph } from "@/components/jams/jam-home";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { jamCodeFrom } from "@/lib/jam";
import { useConnection } from "@/session/connection";

export default function JoinJam() {
  const { origin } = useConnection();
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    const input = jamCodeFrom(text, origin);

    if (!input.ok) {
      setFailure(input.reason);

      return;
    }

    router.push({ pathname: "/jam/[code]", params: { code: input.code } });
  };

  return (
    <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
      <Text variant="hero" accessibilityRole="header" className="pt-12 pb-6">
        {"There’s room\nfor your songs."}
      </Text>
      <Field
        label="Jam link or code"
        placeholder="Paste a link or enter a code"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setFailure(null);
        }}
        autoCapitalize="none"
        keyboardType="url"
        returnKeyType="go"
        error={failure}
        onSubmitEditing={() => {
          if (text.trim() !== "") submit();
        }}
      />
      <View className="pt-6">
        <Button label="Continue" disabled={text.trim() === ""} onPress={submit} />
      </View>
      <Notice
        icon={Info}
        title="Have a QR code?"
        body="Scan the code on the host’s screen with this iPhone."
        className="mt-5"
      />
      <View className="pt-3">
        <Button
          label="Scan QR code"
          icon={QrCode}
          variant="secondary"
          onPress={() => {
            router.push("/jam/scan");
          }}
        />
      </View>
    </Page>
  );
}
