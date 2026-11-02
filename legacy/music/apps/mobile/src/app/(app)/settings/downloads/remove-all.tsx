import { router } from "expo-router";
import { useState } from "react";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useDownloadSettings } from "@/downloads";
import { removeAllCopy } from "@/lib/download-control";
import { DEVICE_FAMILY } from "@/lib/this-device";

export default function RemoveAllDownloads() {
  const { usage, removeAll } = useDownloadSettings();
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
