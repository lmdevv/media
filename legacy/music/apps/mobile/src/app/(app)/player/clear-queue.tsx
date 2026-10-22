/** B10 · Clear the queue? Everything after the current song goes; the song keeps playing. */
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function Screen() {
  // The server call itself, not the player's action, which never rejects: a refusal keeps the
  // sheet open with the reason instead of closing as if the queue were cleared.
  const clearQueue = useRun("queue.clear");

  return (
    <ConfirmSheet
      title="Clear the queue?"
      body="Remove all songs after the one playing. Your current song keeps playing."
      confirmLabel="Clear queue"
      pendingLabel="Clearing…"
      cancelLabel="Keep queue"
      onConfirm={async () => {
        await clearQueue({});
        router.back();
      }}
    />
  );
}
