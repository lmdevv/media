import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useSessionRun } from "@/player";

export default function Screen() {
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
