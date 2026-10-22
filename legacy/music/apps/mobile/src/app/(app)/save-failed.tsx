/**
 * G13 · Couldn't save changes: the sheet a one-tap save opens when the server refuses it. Try
 * again sends the same save; Cancel leaves things as the server kept them.
 */
import { router } from "expo-router";
import { useEffect } from "react";

import { useFailedSave } from "@/components/states/save-failure";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function SaveFailed() {
  const { failure, dismiss } = useFailedSave();

  // Forgets the save once the sheet goes, however it was closed.
  useEffect(() => dismiss, []);

  // Opened with nothing to retry, such as from a stale link.
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
