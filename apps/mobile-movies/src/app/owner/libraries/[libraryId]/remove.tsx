import { LibraryId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Trash2 } from "lucide-react-native";

import { useTask } from "@/components/owner/use-task";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

export default function RemoveLibrary() {
  const params = useLocalSearchParams<{ libraryId: string; name: string }>();
  const libraryId = decodeLibraryId(params.libraryId);
  const remove = useCommand("libraries.remove");
  const exit = useSheetExit();

  const confirm = useTask(async () => {
    await remove({ libraryId });
    router.dismissTo("/owner/libraries");
  });

  return (
    <Sheet
      title={`Remove ${params.name}?`}
      subtitle="This removes the library and its watch history. Original media stays on your server."
      error={confirm.error}
      exit={exit}
    >
      <Button
        label="Remove Library"
        variant="destructive"
        icon={Trash2}
        busy={confirm.busy}
        onPress={() => void confirm.run()}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
