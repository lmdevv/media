/** B10 · Clear the queue? Everything after the current song goes; the song keeps playing. */
import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useSessionRun } from "@/player";

export default function Screen() {
  // The command itself, not the player's action, which never rejects: a refusal keeps the sheet
  // open with the reason instead of closing as if the queue were cleared.
  const run = useSessionRun();

  return (
    <ConfirmSheet
      title="Clear the queue?"
      body="Remove all songs after the one playing. Your current song keeps playing."
      confirmLabel="Clear queue"
      pendingLabel="Clearing…"
      cancelLabel="Keep queue"
      onConfirm={async () => {
        await run("queue.clear", {});
        router.back();
      }}
    />
  );
}
