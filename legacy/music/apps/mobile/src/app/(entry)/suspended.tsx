import { Lock } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { useEndedSession } from "@/session/session-phase";

export default function Suspended() {
  const { forget } = useEndedSession();

  return (
    <Page title="Account" bottom="plain" onBack={null}>
      <EmptyState
        icon={Lock}
        title={"This account\nis suspended."}
        body={"Contact your server admin\nto restore access."}
        primary={<Button label="Sign out" onPress={forget} />}
      />
    </Page>
  );
}
