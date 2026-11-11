import { useState } from "react";

import { Sheet, useSheetExit } from "@/components/title/sheet";
import { ListRow } from "@/components/ui/list-row";
import { DOWNLOAD_QUALITY_OPTIONS } from "@/lib/downloads/settings";
import { describeFailure } from "@/lib/failure";
import { useDownloadQuality } from "@/session/download-settings";

export default function DownloadQuality() {
  const { quality, choose } = useDownloadQuality();
  const exit = useSheetExit();
  const [error, setError] = useState<string | null>(null);

  return (
    <Sheet title="Video Quality" error={error} exit={exit}>
      {DOWNLOAD_QUALITY_OPTIONS.map((option) => {
        const selected = option.id === quality;

        return (
          <ListRow
            key={option.id}
            title={option.label}
            detail={selected ? "Selected" : (option.note ?? undefined)}
            selected={selected}
            onPress={() => {
              setError(null);
              void choose(option.id).then(exit.close, (cause: unknown) => {
                setError(describeFailure(cause));
              });
            }}
          />
        );
      })}
    </Sheet>
  );
}
