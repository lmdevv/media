import { useRun } from "@music/sdk/react";

import { backToMyMusic } from "@/components/jams/jam-home";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function EndJam() {
  const end = useRun("jam.end");

  return (
    <ConfirmSheet
      title="End this Jam?"
      body="Everyone returns to their own player. Temporary guest accounts are removed."
      confirmLabel="End Jam"
      pendingLabel="Ending…"
      cancelLabel="Keep listening"
      onConfirm={async () => {
        await end({});
        backToMyMusic();
      }}
    />
  );
}
