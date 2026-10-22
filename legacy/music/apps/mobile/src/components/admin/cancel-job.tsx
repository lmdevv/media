/** F25 · Stop a running scan; what it already read stays in the library. */
import type { JobId } from "@music/commands/ids";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";

/** The confirmation for cancelling a scan. The job's page underneath turns into G09. */
export function CancelJobSheet({ id }: { readonly id: JobId | null }) {
  const cancel = useRun("jobs.cancel");

  if (id === null) return <SheetLayout title="Job not found" subtitle="The link is out of date." />;

  return (
    <ConfirmSheet
      title="Stop this scan?"
      body="Songs already added stay in your library. You can scan this folder again later."
      confirmLabel="Stop scan"
      pendingLabel="Stopping…"
      cancelLabel="Keep scanning"
      onConfirm={async () => {
        await cancel({ jobId: id });
        router.back();
      }}
    />
  );
}
