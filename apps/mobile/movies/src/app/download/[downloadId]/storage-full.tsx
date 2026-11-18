import { router, useLocalSearchParams } from "expo-router";

import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { nameOf, spaceShortfall } from "@/lib/downloads/model";
import { formatBytes } from "@/lib/owner-format";
import { DOWNLOADS_HREF } from "@/lib/routes";
import { freeSpace } from "@/session/download-engine";
import { useDownload } from "@/session/downloads";

export default function StorageFull() {
  const params = useLocalSearchParams<{ downloadId: string }>();
  const found = useDownload(params.downloadId);
  const exit = useSheetExit();

  if (found === null) return <Sheet title="Download" error="This download was removed." />;
  const { download } = found;
  const needed = (download.totalBytes ?? 0) - download.receivedBytes;
  const shortfall = spaceShortfall(needed, freeSpace());

  return (
    <Sheet
      title="Not enough storage"
      subtitle={`Free up ${formatBytes(shortfall)} to download ${nameOf(download)}.`}
      exit={exit}
    >
      <Button
        label="Manage Downloads"
        onPress={() => {
          exit.close();
          router.navigate(DOWNLOADS_HREF);
        }}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
