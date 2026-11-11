import { router } from "expo-router";
import { Link2 } from "lucide-react-native";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { describeConnectFailure, discoverServer } from "@media/mobile-core/server";
import { useConnectAttempt } from "@/session/connect-attempt";

export default function Connect() {
  const [address, setAddress] = useState("");
  const { busy, failure, clearFailure, run } = useConnectAttempt();
  const filled = address.trim() !== "";

  const submit = async () => {
    const result = await run(() => discoverServer(address), { filled });

    if (result?.ok === false && result.failure === "unreachable") {
      clearFailure();
      router.push({ pathname: "/unreachable", params: { address } });
    }
  };

  return (
    <Screen readable scroll header={<NavHeader title="Connect to Server" fallback="/welcome" />}>
      <TextField
        label="Server address"
        placeholder="https://cinema.home"
        value={address}
        onChangeText={(text) => {
          setAddress(text);
          clearFailure();
        }}
        error={
          failure === null || failure === "unreachable" ? null : describeConnectFailure(failure)
        }
        autoCapitalize="none"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        autoFocus
        onSubmitEditing={() => void submit()}
        className="mt-12"
      />
      <Button label="Continue" busy={busy} disabled={!filled} onPress={() => void submit()} />
      <ListRow
        icon={Link2}
        title="Enter Connection Details"
        onPress={() => router.push("/connection-details")}
      />
    </Screen>
  );
}
