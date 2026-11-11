import { useLocalSearchParams } from "expo-router";
import { Play, RotateCw, Trash2, X } from "lucide-react-native";

import { Sheet, useSheetExit } from "@/components/title/sheet";
import { ListRow } from "@/components/ui/list-row";
import { headingOf, statusOf } from "@/lib/downloads/model";
import { downloadHref, playDownloadHref } from "@/lib/routes";
import { useDownload } from "@/session/downloads";

export default function DownloadActions() {
  const params = useLocalSearchParams<{ downloadId: string }>();
  const found = useDownload(params.downloadId);
  const exit = useSheetExit();

  if (found === null) return <Sheet title="Download" error="This download was removed." />;
  const { engine, download } = found;
  const stopped = download.phase === "interrupted" || download.phase === "noSpace";

  return (
    <Sheet title={headingOf(download)} subtitle={statusOf(download)} exit={exit}>
      {download.phase === "ready" ? (
        <>
          <ListRow
            icon={Play}
            title="Play Download"
            onPress={() => exit.leaveFor(playDownloadHref(download))}
          />
          <ListRow
            icon={Trash2}
            title="Remove Download"
            onPress={() => exit.switchTo(`${downloadHref(download.id)}/remove`)}
          />
        </>
      ) : (
        <>
          {stopped ? (
            <ListRow
              icon={RotateCw}
              title="Retry Download"
              onPress={() => {
                engine.retry(download.id);
                exit.close();
              }}
            />
          ) : null}
          <ListRow
            icon={X}
            title="Cancel Download"
            onPress={() => {
              void engine.remove(download.id);
              exit.close();
            }}
          />
        </>
      )}
    </Sheet>
  );
}
