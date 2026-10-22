/**
 * G05 · Server unreachable: the remembered server hasn't answered since launch. Try again opens a
 * fresh connection to it and waits on it here; Server address goes back to Connect to change it.
 * The root stack leaves this screen by itself once the server answers.
 */
import { Wifi } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { displayHost } from "@/lib/server";
import { useConnection, useConnectionControls } from "@/session/connection";
import { useSilentServer } from "@/session/session-phase";

export default function Unreachable() {
  const { origin, reconnect, disconnect } = useConnection();
  const { attempt } = useConnectionControls();
  const silent = useSilentServer();
  // After Try again, the new connection gets the same wait as launch before it counts as out of
  // reach again. At launch the wait is already over when this screen appears.
  const trying = attempt > 0 && !silent;

  return (
    <Page title="Connection" bottom="plain" onBack={null}>
      <EmptyState
        icon={Wifi}
        title={"Your server\nis out of reach."}
        body={`Check your connection and make sure\n${displayHost(origin)} is running.`}
        primary={
          <Button label="Try again" pendingLabel="Trying…" pending={trying} onPress={reconnect} />
        }
        secondary={<Button label="Server address" variant="secondary" onPress={disconnect} />}
      />
    </Page>
  );
}
