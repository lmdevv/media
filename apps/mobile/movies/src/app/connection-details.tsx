import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import {
  connectManually,
  describeConnectFailure,
  normalizeServerUrl,
} from "@media/mobile-core/server";
import { useConnectAttempt } from "@/session/connect-attempt";

export default function ConnectionDetails() {
  const [mediaUrl, setMediaUrl] = useState("");
  const [convexUrl, setConvexUrl] = useState("");
  const { busy, failure, clearFailure, run } = useConnectAttempt();
  const filled = mediaUrl.trim() !== "" && convexUrl.trim() !== "";

  const submit = () => run(() => connectManually(mediaUrl, convexUrl), { filled });

  const mediaError =
    failure === "unreachable" || (failure === "invalid" && normalizeServerUrl(mediaUrl) === null)
      ? describeConnectFailure(failure)
      : null;

  const convexError =
    failure === null || mediaError !== null ? null : describeConnectFailure(failure);

  return (
    <Screen readable scroll header={<NavHeader title="Connection Details" fallback="/welcome" />}>
      <TextField
        label="Media server"
        placeholder="https://cinema.home"
        value={mediaUrl}
        onChangeText={(text) => {
          setMediaUrl(text);
          clearFailure();
        }}
        error={mediaError}
        autoCapitalize="none"
        keyboardType="url"
        className="mt-8"
      />
      <TextField
        label="Account server"
        placeholder="https://accounts.cinema.home"
        value={convexUrl}
        onChangeText={(text) => {
          setConvexUrl(text);
          clearFailure();
        }}
        error={convexError}
        autoCapitalize="none"
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button label="Connect" busy={busy} disabled={!filled} onPress={() => void submit()} />
    </Screen>
  );
}
