import { useLocalSearchParams } from "expo-router";
import { Trash2 } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { Sheet } from "@/components/title/sheet";
import { useDownload } from "@/session/downloads";

export default function RemoveDownload() {
  const params = useLocalSearchParams<{ downloadId: string }>();
  const found = useDownload(params.downloadId);

  if (found === null) return <Sheet title="Download" error="This download was removed." />;
  const { engine, download } = found;

  return (
    <ConfirmSheet
      title="Remove this download?"
      description="You can download it again from your server."
      action="Remove Download"
      icon={Trash2}
      onConfirm={() => engine.remove(download.id)}
    />
  );
}
