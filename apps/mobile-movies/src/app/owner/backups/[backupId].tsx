import { BackupId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { RotateCcw } from "lucide-react-native";

import { useTask } from "@/components/owner/use-task";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/session/viewer";

const decodeBackupId = Schema.decodeUnknownOption(BackupId);

function NoSuchBackup() {
  const exit = useSheetExit();

  return (
    <Sheet title="Backup not found" exit={exit}>
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}

function ConfirmRestore({ backupId }: { readonly backupId: BackupId }) {
  const restore = useCommand("backups.restore");
  const signOut = useSignOut();
  const exit = useSheetExit();

  const confirm = useTask(async () => {
    await restore({ backupId });
    await signOut();
  });

  return (
    <Sheet
      title="Restore this backup?"
      subtitle="The library database will be replaced. Everyone will need to sign in again."
      error={confirm.error}
      exit={exit}
    >
      <Button
        label="Restore Backup"
        variant="destructive"
        icon={RotateCcw}
        busy={confirm.busy}
        onPress={() => void confirm.run()}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}

export default function RestoreBackup() {
  const params = useLocalSearchParams<{ backupId: string }>();

  return Option.match(decodeBackupId(params.backupId), {
    onNone: () => <NoSuchBackup />,
    onSome: (backupId) => <ConfirmRestore backupId={backupId} />,
  });
}
