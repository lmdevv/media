import { UserId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { UserX } from "lucide-react-native";

import { useTask } from "@/components/owner/use-task";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";

const decodeUserId = Schema.decodeUnknownSync(UserId);

export default function DisableAccount() {
  const params = useLocalSearchParams<{ userId: string; name: string }>();
  const userId = decodeUserId(params.userId);
  const disable = useCommand("users.disable");
  const exit = useSheetExit();

  const confirm = useTask(async () => {
    await disable({ userId });
    exit.close();
  });

  return (
    <Sheet
      title={`Disable ${params.name}?`}
      subtitle="They’re signed out everywhere, and their keys and devices stop working. Their profiles and history stay."
      error={confirm.error}
      exit={exit}
    >
      <Button
        label="Disable Account"
        variant="destructive"
        icon={UserX}
        busy={confirm.busy}
        onPress={() => void confirm.run()}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
