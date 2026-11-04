import { Wifi } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { displayHost } from "@/lib/server";
import { useConnection, useConnectionControls } from "@/session/connection";
import { useSilentServer } from "@/session/server-reach";

export default function Unreachable() {
  const { origin, reconnect, disconnect } = useConnection();
  const { attempt } = useConnectionControls();
  const silent = useSilentServer();
  const trying = attempt > 0 && !silent;

  return (
    <Page title="Connection" bottom="plain" onBack={null}>
      <EmptyState
        icon={Wifi}
        title={"Your server\nis out of reach."}
        body={`Check your connection and make sure\n${displayHost(origin)} is running.`}
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
