import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { jamNavGlyph } from "@/components/jams/jam-home";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { parseJamLink } from "@/lib/jam";

/** Joins a Jam by the link someone sent, pasted here. */
export default function JoinJam() {
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    const link = parseJamLink(text);

    if (link === null) {
      setFailure("That isn’t a Jam link.");

      return;
    }

    router.push({ pathname: "/jam/[link]", params: { link } });
  };

  return (
    <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
      <Text variant="hero" accessibilityRole="header" className="pt-12 pb-6">
        {"There’s room\nfor your songs."}
      </Text>
      <Field
        label="Jam link"
        placeholder="Paste the link the host sent"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setFailure(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
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
    </Page>
  );
}
