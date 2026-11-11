import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { displayHost } from "@/lib/local-network";
import { useConnection, useServer } from "@/session/connection";

export default function ConnectedServer() {
  const server = useServer();
  const { disconnect } = useConnection();
  const exit = useSheetExit();

  return (
    <Sheet title={displayHost(server.mediaUrl)} exit={exit}>
      <Text variant="mono" tone="muted" selectable>
        {server.mediaUrl}
      </Text>
      <Button label="Change Server" variant="secondary" onPress={disconnect} />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
