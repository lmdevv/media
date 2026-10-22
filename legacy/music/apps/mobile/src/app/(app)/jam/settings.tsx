/**
 * D04 · Jam settings, the host's: who can join, adding songs and how many, controlling playback,
 * editing the queue, and listening along. Changes are a draft until the check saves them.
 */
import type { JamEditScope, JamJoinPolicy } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Check, ListOrdered, Settings, ShieldAlert } from "lucide-react-native";
import { useState } from "react";
import { ActionSheetIOS } from "react-native";

import { ToggleRow } from "@/components/jams/toggle-row";
import { ChipGroup } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { ADD_LIMITS, addLimitLine, settingsChanges } from "@/lib/jam";
import type { SettingsDraft } from "@/lib/jam";

const JOIN_OPTIONS: ReadonlyArray<{ readonly value: JamJoinPolicy; readonly label: string }> = [
  { value: "open", label: "Anyone" },
  { value: "approval", label: "Approval" },
  { value: "locked", label: "Locked" },
];

const EDIT_OPTIONS: ReadonlyArray<{ readonly value: JamEditScope; readonly label: string }> = [
  { value: "none", label: "None" },
  { value: "own", label: "Their songs" },
  { value: "any", label: "Any song" },
];

/** Labels for the limits, in the order the action sheet lists them. */
const LIMIT_LABELS = ADD_LIMITS.map((limit) => (limit === null ? "No limit" : String(limit)));

/** Songs per person: Paper's row, opening the native action sheet of limits. */
function AddLimitRow({
  value,
  onChange,
}: {
  readonly value: number | null;
  readonly onChange: (limit: number | null) => void;
}) {
  const pick = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Songs per person",
        message: "How many upcoming songs each person can have in the queue.",
        options: [...LIMIT_LABELS, "Cancel"],
        cancelButtonIndex: LIMIT_LABELS.length,
      },
      (index) => {
        if (index >= ADD_LIMITS.length) return;
        void Haptics.selectionAsync();
        onChange(ADD_LIMITS[index] ?? null);
      },
    );
  };

  return (
    <Row
      title="Songs per person"
      subtitle={addLimitLine(value)}
      leading={{ kind: "icon", icon: ListOrdered, tone: "muted" }}
      trailing={<RowChevron />}
      onPress={pick}
    />
  );
}

/** The settings form over the saved settings. */
function SettingsForm({
  saved,
  approvalAfterRemoval,
}: {
  readonly saved: SettingsDraft;
  readonly approvalAfterRemoval: boolean;
}) {
  const save = useRun("jam.settings");
  const [draft, setDraft] = useState<SettingsDraft>(saved);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (change: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
  };

  const submit = async () => {
    const changes = settingsChanges(saved, draft);

    if (Object.keys(changes).length === 0) {
      router.back();

      return;
    }

    setPending(true);
    setFailure(null);

    try {
      await save(changes);
      router.back();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t save. Try again.");
      setPending(false);
    }
  };

  return (
    <Page
      title="Jam settings"
      bottom="plain"
      trailing={
        <IconButton
          icon={Check}
          label={pending ? "Saving" : "Save"}
          disabled={pending}
          onPress={() => void submit()}
        />
      }
    >
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2">
          {failure}
        </Text>
      )}
      <SectionHeader title="Who can join" />
      <ChipGroup
        label="Who can join"
        options={JOIN_OPTIONS}
        value={draft.join}
        onChange={(join) => {
          set({ join });
        }}
      />
      {approvalAfterRemoval && draft.join === "open" ? (
        <Notice
          icon={ShieldAlert}
          title="New people need your OK for now"
          body="You removed someone, so this link asks you about everyone new. A new link lets people straight in again."
          className="mb-2"
        />
      ) : null}
      <ToggleRow
        title="Members can add songs"
        subtitle="Let people contribute to the queue."
        value={draft.membersCanAdd}
        onValueChange={(membersCanAdd) => {
          set({ membersCanAdd });
        }}
      />
      {draft.membersCanAdd ? (
        <AddLimitRow
          value={draft.addLimit}
          onChange={(addLimit) => {
            set({ addLimit });
          }}
        />
      ) : null}
      <ToggleRow
        title="Members can control playback"
        subtitle="Play, pause, skip, and seek."
        value={draft.membersCanControl}
        onValueChange={(membersCanControl) => {
          set({ membersCanControl });
        }}
      />
      <SectionHeader title="Queue editing" />
      <ChipGroup
        label="Queue editing"
        options={EDIT_OPTIONS}
        value={draft.membersCanEdit}
        onChange={(membersCanEdit) => {
          set({ membersCanEdit });
        }}
      />
      <ToggleRow
        title="Listen along"
        subtitle="Allow members to play on their own devices."
        value={draft.listenAlong}
        onValueChange={(listenAlong) => {
          set({ listenAlong });
        }}
      />
      <Row
        title="Manage link & end Jam"
        subtitle="Refresh the link or end the session"
        leading={{ kind: "icon", icon: Settings, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.push("/jam/manage");
        }}
      />
    </Page>
  );
}

export default function JamSettingsScreen() {
  const jam = useRead("jam.get", {});

  if (jam === undefined || jam === null || jam.role !== "host" || jam.status !== "active") {
    return (
      <Page title="Jam settings" bottom="plain">
        {null}
      </Page>
    );
  }

  return <SettingsForm saved={jam.settings} approvalAfterRemoval={jam.approvalAfterRemoval} />;
}
