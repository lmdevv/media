import { router } from "expo-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { describeConnectFailure, discoverServer } from "@media/mobile-core/server";
import { parseInviteLink } from "@/lib/invite-link";
import { useConnectAttempt } from "@/session/connect-attempt";
import { usePendingInvite } from "@/session/pending-invite";

const NOT_A_LINK = "Paste the invite link, such as https://cinema.home/invite/…";

export default function OpenInvite() {
  const [text, setText] = useState("");
  const [notALink, setNotALink] = useState(false);
  const { busy, failure, clearFailure, run } = useConnectAttempt();
  const { setInvite } = usePendingInvite();
  const filled = text.trim() !== "";

  const submit = async () => {
    const link = parseInviteLink(text);

    if (link === null) {
      setNotALink(filled);

      return;
    }

    const result = await run(() => discoverServer(link.server), {
      filled,
      beforeConnect: (connection) => setInvite({ server: connection.mediaUrl, code: link.code }),
    });

    if (result?.ok === false && result.failure === "unreachable") {
      clearFailure();
      router.push({
        pathname: "/unreachable",
        params: { address: link.server, invite: link.code },
      });
    }
  };

  const error = notALink
    ? NOT_A_LINK
    : failure === null || failure === "unreachable"
      ? null
      : describeConnectFailure(failure);

  return (
    <Screen readable scroll header={<NavHeader title="Open an Invite" fallback="/welcome" />}>
      <TextField
        label="Invite link"
        placeholder="https://cinema.home/invite/…"
        value={text}
        onChangeText={(next) => {
          setText(next);
          setNotALink(false);
          clearFailure();
        }}
        error={error}
        autoCapitalize="none"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        autoFocus
        onSubmitEditing={() => void submit()}
        className="mt-12"
      />
      <Button label="Continue" busy={busy} disabled={!filled} onPress={() => void submit()} />
    </Screen>
  );
}
