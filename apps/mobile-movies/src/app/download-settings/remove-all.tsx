import { Trash2 } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useDownloads } from "@/session/downloads";

export default function RemoveAllDownloads() {
  const { engine } = useDownloads();

  return (
    <ConfirmSheet
      title="Remove all downloads?"
      description="You can download them again from your server."
      action="Remove All Downloads"
      icon={Trash2}
      onConfirm={() => engine?.removeAll() ?? Promise.resolve()}
    />
  );
}
