import { useCommand } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { roomIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";

export default function EndRoom() {
  const params = useLocalSearchParams<{ roomId: string }>();
  const roomId = roomIdParam(params.roomId);
  const endRoom = useCommand("rooms.end");
  const exit = useSheetExit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const end = () => {
    if (roomId === null) return;
    setBusy(true);
    setError(null);
    void endRoom({ roomId, deviceId: deviceId() }).then(
      () => {
        exit.close();

        return undefined;
      },
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  return (
    <Sheet
      title="End this room?"
      subtitle="Playback will stop for everyone."
      error={error}
      exit={exit}
    >
      <Button label="End Room" variant="destructive" busy={busy} onPress={end} />
      <Button label="Keep Watching" onPress={exit.close} />
    </Sheet>
  );
}
