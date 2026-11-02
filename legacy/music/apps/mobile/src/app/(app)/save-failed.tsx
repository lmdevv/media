import { router } from "expo-router";
import { useEffect } from "react";

import { useFailedSave } from "@/components/states/save-failure";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function SaveFailed() {
  const { failure, dismiss } = useFailedSave();

  useEffect(() => dismiss, []);

  useEffect(() => {
    if (failure === null) router.back();
  }, [failure]);

  if (failure === null) return null;

  return (
    <ConfirmSheet
      title="Couldn’t save changes"
      body={`${failure.unchanged} Check your connection and try again.`}
      confirmLabel="Try again"
      pendingLabel="Trying…"
      tone="primary"
      onConfirm={async () => {
        await failure.retry();
        router.back();
      }}
    />
  );
}
