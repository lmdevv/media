import { SOURCE_NAMES, failureLine } from "@media/contracts/migration-plan";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type { MigrationSourceFailure } from "@media/contracts/models/migration";
import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { RotateCcw } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Chip } from "@/components/browse/chip";
import { useImportState, usePreview } from "@/components/owner/import-state";
import { OwnerScreen } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { CREDENTIAL_LABELS } from "@/lib/migration";
import { isActive } from "@/lib/scans";

const SOURCES: ReadonlyArray<MigrationSource> = ["jellyfin", "plex"];

const PLACEHOLDERS: Readonly<Record<MigrationSource, string>> = {
  jellyfin: "http://jellyfin.local:8096",
  plex: "http://plex.local:32400",
};

const withScheme = (url: string): string => {
  const trimmed = url.trim();

  return /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
};

export default function ImportLibrary() {
  const { form, setForm, setPreview } = useImportState();
  const runs = useCommandQuery("migration.status", {});
  const preview = usePreview();
  const [failure, setFailure] = useState<MigrationSourceFailure | null>(null);
  const active = runs.status === "success" ? runs.data.find((run) => isActive(run.job)) : undefined;
  const activeId = active?.job.id;

  useEffect(() => {
    if (activeId !== undefined) {
      router.replace({ pathname: "/owner/import/progress", params: { jobId: activeId } });
    }
  }, [activeId]);

  const connect = useTask(async () => {
    const sent = { ...form, url: withScheme(form.url) };
    const result = await preview(sent);

    setForm(sent);

    if (result.status === "failed") {
      setFailure(result);

      return;
    }

    setFailure(null);
    setPreview({ connection: result.connection, report: result.report });
    router.push("/owner/import/review");
  });

  const line = failure === null ? null : failureLine(failure, form.source);

  const change = (next: Partial<typeof form>) => {
    setForm({ ...form, ...next });
    setFailure(null);
    connect.clearError();
  };

  return (
    <OwnerScreen title="Import Library">
      <View className="flex-row gap-2" accessibilityRole="radiogroup">
        {SOURCES.map((source) => (
          <Chip
            key={source}
            label={SOURCE_NAMES[source]}
            selected={form.source === source}
            onPress={() => change({ source })}
          />
        ))}
      </View>
      <TextField
        label="Server Address"
        placeholder={PLACEHOLDERS[form.source]}
        value={form.url}
        onChangeText={(url) => change({ url })}
        error={line?.field === "url" ? line.message : null}
        autoCapitalize="none"
        keyboardType="url"
        // Not a username either: with the key below, iOS would offer to save them as a login.
        textContentType="none"
        returnKeyType="next"
      />
      <TextField
        label={CREDENTIAL_LABELS[form.source]}
        value={form.token}
        onChangeText={(token) => change({ token })}
        error={line?.field === "token" ? line.message : null}
        secureTextEntry
        autoCapitalize="none"
        // A source's key, not this account's password: keep iOS from offering to save it.
        textContentType="none"
        autoComplete="off"
        returnKeyType="go"
        onSubmitEditing={() => void connect.run()}
      />
      {connect.error === null ? null : (
        <Text variant="meta" tone="danger">
          {connect.error}
        </Text>
      )}
      <Button
        label={failure === null ? "Connect" : "Try Again"}
        icon={failure === null ? undefined : RotateCcw}
        busy={connect.busy}
        disabled={form.url.trim() === "" || form.token.trim() === ""}
        onPress={() => void connect.run()}
      />
    </OwnerScreen>
  );
}
