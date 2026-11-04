import { Airplay, Info, Lock } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";

import { useHoldEntryLink } from "./entry-links";
import { parseEntryLink } from "@/lib/entry-link";
import { describeConnectFailure, discoverServer } from "@/lib/server";
import type { ServerConnection } from "@/lib/server";

export interface ConnectFormProps {
  /** What Back does; see `NavBar`. */
  readonly onBack: () => void;
  /** Runs with the server found at the address. */
  readonly onConnected: (connection: ServerConnection) => void;
}

/** The Connect page: address, Connect, and what went wrong. */
export function ConnectForm({ onBack, onConnected }: ConnectFormProps) {
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const holdLink = useHoldEntryLink();

  const submit = async () => {
    setPending(true);
    setFailure(null);

    const link = parseEntryLink(address);
    const result = await discoverServer(link?.server ?? address, fetch);

    setPending(false);

    if (!result.ok) {
      setFailure(describeConnectFailure(result.failure));

      return;
    }

    if (link !== null) holdLink(link);
    onConnected(result.connection);
  };

  return (
    <Page
      title="Connect"
      bottom="plain"
      onBack={onBack}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Info} />
        </View>
      }
    >
      <View className="pt-8 pb-4">
        <Icon icon={Airplay} tone="muted" size="hero" />
      </View>
      <Text variant="largeTitle">{"Bring your\ncollection along."}</Text>
      <Field
        label="Server address"
        helper="The address you use to open [music] in your browser."
        placeholder="https://music.example"
        value={address}
        onChangeText={(text) => {
          setAddress(text);
          setFailure(null);
        }}
        error={failure}
        keyboardType="url"
        textContentType="URL"
        autoCapitalize="none"
        returnKeyType="go"
        editable={!pending}
        onSubmitEditing={() => void submit()}
      />
      <View className="pt-6">
        <Button
          label="Connect"
          pendingLabel="Connecting…"
          pending={pending}
          disabled={address.trim() === ""}
          onPress={() => void submit()}
        />
      </View>
      <Notice
        icon={Lock}
        title="Your server, your music"
        body="Use your home server’s address or a remote address set up by its owner."
        className="mt-6"
      />
    </Page>
  );
}
