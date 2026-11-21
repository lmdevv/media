import { Wifi } from "lucide-react-native";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { displayHost } from "@/lib/server";
import { useConnection, useConnectionControls } from "@/session/connection";

/** How long Try again shows it is trying before the server counts as silent again (G05). */
const TRYING_MS = 8000;

const useTrying = (attempt: number): boolean => {
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (attempt === 0) return undefined;

    const timer = setTimeout(() => setWaited(attempt), TRYING_MS);

    return () => clearTimeout(timer);
  }, [attempt]);

  return attempt > 0 && waited !== attempt;
};

export default function Unreachable() {
  const { mediaUrl, reconnect, disconnect } = useConnection();
  const { attempt } = useConnectionControls();
  const trying = useTrying(attempt);

  return (
    <Page title="Connection" bottom="plain" onBack={null}>
      <EmptyState
        icon={Wifi}
        title={"Your server\nis out of reach."}
        body={`Check your connection and make sure\n${displayHost(mediaUrl)} is running.`}
        primary={
          <Button
            label="Try again"
            pendingLabel="Trying…"
            pending={trying}
            onPress={() => reconnect("unreachable")}
          />
        }
        secondary={<Button label="Server address" variant="secondary" onPress={disconnect} />}
      />
    </Page>
  );
}
