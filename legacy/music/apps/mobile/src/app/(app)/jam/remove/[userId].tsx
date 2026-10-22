/** D03 → D09 · Remove someone from the Jam: the host confirms in a sheet. */
import { useRead, useRun } from "@music/sdk/react";
import { router, useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function RemoveFromJam() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const jam = useRead("jam.get", {});
  const remove = useRun("jam.remove");
  const member = jam?.members.find((candidate) => candidate.person.id === userId);
  const name = member?.person.name ?? "them";

  return (
    <ConfirmSheet
      title={`Remove ${name}?`}
      body="They leave the Jam and can’t rejoin with this link. A new link lets them back in."
      confirmLabel="Remove"
      pendingLabel="Removing…"
      onConfirm={async () => {
        if (member === undefined) return;
        await remove({ userId: member.person.id });
        router.back();
      }}
    />
  );
}
