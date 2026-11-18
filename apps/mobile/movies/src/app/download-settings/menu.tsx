import { Settings2, Trash2 } from "lucide-react-native";

import { Sheet, useSheetExit } from "@/components/title/sheet";
import { ListRow } from "@/components/ui/list-row";

export default function DownloadsMenu() {
  const exit = useSheetExit();

  return (
    <Sheet title="Downloads" exit={exit}>
      <ListRow
        icon={Settings2}
        title="Download Settings"
        onPress={() => exit.leaveFor("/download-settings")}
      />
      <ListRow
        icon={Trash2}
        title="Remove All Downloads"
        onPress={() => exit.switchTo("/download-settings/remove-all")}
      />
    </Sheet>
  );
}
