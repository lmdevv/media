/**
 * D17 · Remove all downloads?: every download leaves this iPhone at once; the server's library is
 * untouched, and the server hears when it answers.
 */
import { router } from "expo-router";
import { useState } from "react";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useDownloadSettings } from "@/downloads";
import { removeAllCopy } from "@/lib/download-control";
import { DEVICE_FAMILY } from "@/lib/this-device";

export default function RemoveAllDownloads() {
  const { usage, removeAll } = useDownloadSettings();
  // Worded once: the sheet must not change its words while it closes over the removal.
  const [copy] = useState(() => removeAllCopy(usage, DEVICE_FAMILY));

  return (
    <ConfirmSheet
      title="Remove all downloads?"
      body={copy.body}
      confirmLabel={copy.confirmLabel}
      pendingLabel="Removing…"
      cancelLabel="Keep downloads"
      onConfirm={async () => {
        await removeAll();
        router.back();
      }}
    />
  );
}
