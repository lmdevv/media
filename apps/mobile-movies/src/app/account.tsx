import { useAllPages } from "@media/mobile-core/pages";
import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { KeyRound, Lock, Server } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { displayHost } from "@/lib/local-network";
import { useServer } from "@/session/connection";
import { useMe } from "@/session/me";
import type { Me } from "@/session/me";

/**
 * The name the person goes by, which greetings and lists show. Saving it empty clears it, so
 * they go by their username again.
 */
function NameField({ me }: { readonly me: Me }) {
  const platform = usePlatform();
  const [draft, setDraft] = useState(me.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const next = trimmed === "" ? null : trimmed;
  const unchanged = next === me.displayName;

  const save = async () => {
    if (unchanged || busy) return;
    setBusy(true);
    setError(null);

    try {
      await platform.core.accounts.me.setDisplayName({ displayName: next });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TextField
        label="Name"
        value={draft}
        placeholder={me.username}
        onChangeText={setDraft}
        onSubmitEditing={() => void save()}
        error={error}
        maxLength={64}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        returnKeyType="done"
      />
      {unchanged ? null : (
        <Button label="Save Name" variant="secondary" busy={busy} onPress={() => void save()} />
      )}
    </>
  );
}

export default function Account() {
  const me = useMe();
  const server = useServer();
  const platform = usePlatform();
  const accountScope = me.scopes.includes("account");

  const keys = useAllPages(
    platform.core.auth.apiKeys.list,
    accountScope ? (paginationOpts) => ({ paginationOpts }) : "skip",
  );

  return (
    <Screen readable scroll header={<NavHeader title="Account" fallback="/you" />}>
      {accountScope ? (
        <NameField key={me.displayName ?? ""} me={me} />
      ) : (
        <TextField label="Name" value={me.displayName ?? me.username} editable={false} />
      )}
      <TextField label="Username" value={me.username} editable={false} />
      {accountScope ? (
        <>
          <ListRow
            icon={Lock}
            title="Change Password"
            onPress={() => router.push("/change-password")}
          />
          <ListRow
            icon={KeyRound}
            title="API Keys"
            {...(keys.status === "ready" && keys.next.kind === "done"
              ? { detail: String(keys.rows.length) }
              : {})}
            onPress={() => router.push("/api-keys")}
          />
        </>
      ) : null}
      <ListRow
        icon={Server}
        title="Connected Server"
        detail={displayHost(server.mediaUrl)}
        onPress={() => router.push("/connected-server")}
      />
      <View className="h-8" />
      <Button label="Sign Out" variant="secondary" onPress={() => router.push("/sign-out")} />
    </Screen>
  );
}
