import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import type { JobId } from "@/lib/ids";
import { useCore } from "@/lib/platform";

const decodeAttempt = Schema.decodeUnknownOption(Schema.FiniteFromString);

/**
 * The confirmation for cancelling a scan, at the attempt its page showed: a scan that started over
 * since keeps running, and the sheet says so. The job's page underneath turns into G09.
 */
export function CancelJobSheet({ id }: { readonly id: JobId | null }) {
  const core = useCore();
  const attempt = Option.getOrNull(decodeAttempt(useLocalSearchParams().attempt));

  if (id === null || attempt === null) {
    return <SheetLayout title="Job not found" subtitle="The link is out of date." />;
  }

  return (
    <ConfirmSheet
      title="Stop this scan?"
      body="Songs already added stay in your library. You can scan this folder again later."
      confirmLabel="Stop scan"
      pendingLabel="Stopping…"
      cancelLabel="Keep scanning"
      onConfirm={async () => {
        const answer = await core.libraries.cancelScan({ jobId: id, attempt });

        if (answer.outcome === "movedOn")
          throw new Error("The scan started over meanwhile. Open it again.");

        router.back();
      }}
    />
  );
}
